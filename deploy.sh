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

compose config --quiet
compose build --pull
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

echo "Ждём healthcheck бэкенда (до ${HEALTH_TIMEOUT} с)…"
deadline=$((SECONDS + HEALTH_TIMEOUT))
while :; do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$backend_cid" 2>/dev/null || true)"
  restarts="$(docker inspect -f '{{.RestartCount}}' "$backend_cid" 2>/dev/null || echo 0)"

  # up -d создал контейнер заново, поэтому счётчик начинался с нуля: любой
  # перезапуск здесь означает, что процесс умер (restart: unless-stopped
  # поднял его снова). Ждать healthy в таком цикле бессмысленно.
  if [[ "$restarts" != "0" ]]; then
    echo "backend перезапускался ${restarts} раз(а) — процесс падает на старте. Последние строки лога:" >&2
    compose logs --tail=80 backend >&2
    exit 1
  fi

  case "$status" in
    healthy)
      echo "backend: healthy"
      break
      ;;
    unhealthy)
      # start_period уже истёк, а проверки продолжают падать — это не гонка.
      echo "backend: unhealthy. Последние строки лога:" >&2
      compose logs --tail=80 backend >&2
      exit 1
      ;;
  esac
  if ((SECONDS >= deadline)); then
    echo "backend не стал healthy за ${HEALTH_TIMEOUT} с (статус: ${status:-нет данных}). Последние строки лога:" >&2
    compose logs --tail=80 backend >&2
    exit 1
  fi
  sleep 5
done

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
if compose exec -T nginx nginx -s reload 2>/dev/null; then
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
