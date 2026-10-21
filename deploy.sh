#!/usr/bin/env bash
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env}"
# Потолок ожидания бэкенда. Больше, чем start_period healthcheck'а (90 с в
# docker-compose.prod.yml): на холодной БД сначала прогоняются миграции.
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-240}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Copy .env.example and fill production values." >&2
  exit 1
fi

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# Ждёт healthcheck контейнера бэкенда; при провале печатает его лог и
# возвращает 1 (а не exit): rolling-подмене ниже нужно убрать за собой
# неудачный новый контейнер, оставив старый обслуживать трафик.
wait_backend_healthy() {
  local cid="$1" status restarts deadline=$((SECONDS + HEALTH_TIMEOUT))
  echo "Ждём healthcheck бэкенда ${cid:0:12} (до ${HEALTH_TIMEOUT} с)…"
  while :; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null || true)"
    restarts="$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null || echo 0)"

    # Контейнер свежесозданный, поэтому счётчик начинался с нуля: любой
    # перезапуск здесь означает, что процесс умер (restart: unless-stopped
    # поднял его снова). Ждать healthy в таком цикле бессмысленно.
    if [[ "$restarts" != "0" ]]; then
      echo "backend перезапускался ${restarts} раз(а) — процесс падает на старте. Последние строки лога:" >&2
      docker logs --tail=80 "$cid" >&2
      return 1
    fi

    case "$status" in
      healthy)
        echo "backend: healthy"
        return 0
        ;;
      unhealthy)
        # start_period уже истёк, а проверки продолжают падать — это не гонка.
        echo "backend: unhealthy. Последние строки лога:" >&2
        docker logs --tail=80 "$cid" >&2
        return 1
        ;;
    esac
    if ((SECONDS >= deadline)); then
      echo "backend не стал healthy за ${HEALTH_TIMEOUT} с (статус: ${status:-нет данных}). Последние строки лога:" >&2
      docker logs --tail=80 "$cid" >&2
      return 1
    fi
    sleep 5
  done
}

nginx_reload() { compose exec -T nginx nginx -s reload 2>/dev/null; }

compose config --quiet
compose build --pull

# ─────────────────── подмена бэкенда без простоя ───────────────────
# Простой `up -d` сначала гасит старый backend, потом поднимает новый, и всё
# окно (alembic + загрузка воркеров gunicorn, 12+ с) nginx отвечает 502 — на
# проде это пачки тостов «Ошибка запроса (502)» на каждом деплое (2026-10-21).
# Поэтому новый контейнер поднимается РЯДОМ со старым (--scale +1
# --no-recreate), и только когда он healthy, старый уходит. nginx резолвит
# `backend` во все адреса сервиса (Docker DNS отдаёт по A-записи на
# контейнер), так что после reload ходит в оба; на остановленный старый
# получает connection refused и переспрашивает живой (proxy_next_upstream).
# Миграции новый образ катит, пока старый ещё обслуживает запросы, — они
# должны быть совместимы со старым кодом (добавить колонку — да, переименовать
# — в два деплоя).
# shellcheck disable=SC2207  # ID контейнеров без пробелов
old_backends=($(compose ps -q backend))
# Тот же образ и тот же конфиг — подменять нечего: `up -d` ниже backend не
# тронет, как и раньше при деплое одного фронта.
backend_changed=1
if ((${#old_backends[@]} == 1)) &&
  [[ "$(docker inspect -f '{{.Image}}' "${old_backends[0]}")" == "$(docker image inspect -f '{{.Id}}' music-service/backend:prod)" ]] &&
  [[ "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "${old_backends[0]}")" == "$(compose config --hash backend | awk '{print $2}')" ]]; then
  backend_changed=0
  echo "backend: образ и конфиг не менялись — подмена не нужна"
fi
if ((${#old_backends[@]} > 0 && backend_changed)); then
  compose up -d --no-deps --no-recreate --scale "backend=$((${#old_backends[@]} + 1))" backend
  new_backend=""
  for cid in $(compose ps -q backend); do
    [[ " ${old_backends[*]} " == *" $cid "* ]] || new_backend="$cid"
  done
  if [[ -z "$new_backend" ]]; then
    echo "Новый контейнер backend не появился — смотрите вывод compose выше." >&2
    exit 1
  fi
  if ! wait_backend_healthy "$new_backend"; then
    echo "Новый backend не поднялся — убираю его, старый продолжает работать." >&2
    docker rm -f "$new_backend" >/dev/null
    exit 1
  fi
  nginx_reload || true
  # gunicorn на SIGTERM перестаёт принимать соединения и даёт текущим запросам
  # до 30 с (graceful_timeout по умолчанию), отсюда -t 35.
  # Пока старый гасится, его IP ещё жив и отвечает refused — nginx сразу
  # уходит на новый. После выхода контейнера адрес пропадает из сети, и
  # connect на него висит до ARP-таймаута (~3 с), поэтому reload сразу.
  docker stop -t 35 "${old_backends[@]}" >/dev/null
  nginx_reload || true
  docker rm "${old_backends[@]}" >/dev/null
  echo "backend: старый контейнер заменён новым ${new_backend:0:12}"
fi

# Остальные сервисы. backend уже на свежем образе с текущим конфигом, и
# compose его не пересоздаёт.
compose up -d --remove-orphans
compose ps

# ─────────────────── проверка, что деплой действительно живой ───────────────────
# `up -d` возвращается сразу после запуска контейнеров: бэкенд в этот момент
# ещё выполняет `alembic upgrade head` и может упасть на старте (битая
# миграция, неполный SMTP при SMTP_REQUIRED=true, недоступный MinIO). Без
# проверки ниже скрипт рапортовал бы об успехе, а CD-джоба светилась зелёным
# над мёртвым сервисом.

backend_cid="$(compose ps -aq backend | head -n1)"
if [[ -z "$backend_cid" ]]; then
  echo "Контейнер backend не создан — смотрите вывод compose ps выше." >&2
  exit 1
fi
wait_backend_healthy "$backend_cid" || exit 1

# Перечитывание конфига nginx — обязательный шаг, а не гигиена. В
# nginx/conf.d/00-upstreams.conf апстрим задан статически (`server backend:8000`),
# поэтому имя контейнера резолвится ОДИН раз при старте процесса и дальше в
# памяти живёт IP. `up -d` пересоздаёт backend (новый образ = новый контейнер),
# Docker выдаёт ему новый адрес в сети, а nginx сам не пересоздаётся, если его
# образ не изменился, — и продолжает стучаться на исчезнувший IP. Наружу это
# 502 на каждом запросе, в логе nginx — "connect() failed (113: Host is
# unreachable) ... upstream: http://172.18.0.x:8000".
#
# Reload (а не restart) — без обрыва соединений: мастер поднимает новых воркеров
# с заново отрезолвленными апстримами. Не выходим по ошибке: если reload не
# удался, ниже это поймает проверка /api/health и завалит деплой с логом nginx.
if nginx_reload; then
  echo "nginx: конфиг перечитан, апстримы отрезолвлены заново"
else
  echo "nginx: reload не удался — проверяю доступность сервиса ниже" >&2
fi

# Здоровый контейнер ещё не значит доступный сервис: наружу слушает только
# nginx, и он может не подняться отдельно (битый шаблон конфига, отсутствующий
# сертификат). Поэтому дополнительно дёргаем /api/health через сам nginx.
domain="$(grep -E '^[[:space:]]*DOMAIN=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
domain="${domain%$'\r'}"   # файл мог быть сохранён с CRLF
domain="${domain//\"/}"
domain="${domain//\'/}"
domain="${domain// /}"

http_code() {  # печатает HTTP-код ответа или 000, если соединения не было
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null || true)"
  echo "${code:-000}"
}

if ! command -v curl >/dev/null 2>&1; then
  echo "curl не найден — проверка через nginx пропущена."
elif [[ -z "$domain" ]]; then
  echo "DOMAIN не найден в $ENV_FILE — проверка через nginx пропущена."
else
  # --resolve прибивает запрос к локальному nginx: проверка не зависит от DNS
  # и от того, куда сейчас смотрит A-запись. -k — сертификат здесь не предмет
  # проверки (истёкший поймает certbot, а не деплой).
  #
  # Ретраи, а не одна попытка: единичный 502 сразу после reload ещё не мёртвый
  # деплой. Бэкенд может упасть и перезапуститься ПОСЛЕ первого успешного
  # healthcheck (crash на старте, чаще всего OOM): wait-цикл выше уже вышел по
  # healthy и не увидит ни рестарта, ни смены статуса, а restart-политика
  # поднимает контейнер заново за десятки секунд (alembic + boot gunicorn).
  # Наружу это выглядит как раз как наблюдавшийся случай: reload прошёл,
  # "upstream ... (111: Connection refused)" от свежего воркера, 502. Окно
  # закрываем ретраями; если за минуту сервис не вернулся — деплой краснеет.
  echo "Проверяем /api/health через nginx (до 60 с с ретраями)…"
  check_deadline=$((SECONDS + 60))
  while :; do
    https_code="$(http_code -k --resolve "${domain}:443:127.0.0.1" "https://${domain}/api/health")"
    if [[ "$https_code" == "200" ]]; then
      echo "nginx: /api/health отвечает 200 по https"
      break
    fi
    # Пока сертификата нет, entrypoint разворачивает http-only конфиг
    # (см. nginx/docker-entrypoint.sh) — на первом деплое это норма.
    plain_code="$(http_code -H "Host: ${domain}" "http://127.0.0.1/api/health")"
    if [[ "$plain_code" == "200" ]]; then
      echo "nginx: /api/health отвечает 200 по http (сертификата ещё нет — ожидаемо до init-letsencrypt.sh)"
      break
    fi
    if ((SECONDS >= check_deadline)); then
      echo "nginx не отдаёт /api/health за 60 с (https=${https_code}, http=${plain_code})." >&2
      # 502 с "connect() failed" в логе nginx почти всегда означает лежащий
      # бэкенд, а не проблему самого nginx. Без его лога и счётчика рестартов
      # причина не видна — дампим оба.
      backend_restarts="$(docker inspect -f '{{.RestartCount}}' "$backend_cid" 2>/dev/null || echo '?')"
      backend_health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$backend_cid" 2>/dev/null || echo '?')"
      echo "backend: RestartCount=${backend_restarts}, health=${backend_health}. Логи backend и nginx:" >&2
      compose logs --tail=60 backend >&2
      compose logs --tail=40 nginx >&2
      exit 1
    fi
    sleep 5
  done
fi

echo "Deployment completed."
