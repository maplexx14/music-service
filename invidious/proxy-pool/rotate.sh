#!/usr/bin/env bash
# Ротация исходящего прокси invidious-companion при блокировке со стороны
# YouTube/BotGuard.
#
#   rotate.sh                 авто: проверить и при деградации сменить выход
#                             (так его запускает таймер, см. systemd/)
#   rotate.sh --activate N    назначить N-й прокси из списка вручную; этим же
#                             создаётся active.env при первой установке
#   rotate.sh --status        какой выход активен и кто сейчас «отдыхает»
#
# Зачем именно так:
#
#  * Проверка — по СПОСОБНОСТИ, а не по живости. Companion при неудачном
#    выпуске PO-token не падает и не закрывает порт: он продолжает отвечать,
#    но в ответе Invidious больше нет audio-форматов. Docker healthcheck такое
#    не видит, поэтому пробуем ровно то, что делает бэкенд в
#    _resolve_via_invidious (backend/app/routers/ytdlp.py) — ищем в
#    /api/v1/videos/{id} формат с type=audio*.
#
#  * Прежде чем менять выход, скрипт спрашивает сам прокси. Если текущий
#    адрес YouTube всё ещё обслуживает (watch-страница отдаёт
#    playabilityStatus OK), то дело не в IP, а в протухшей сессии — тогда
#    достаточно перевыпустить её на том же прокси и не тратить адрес из пула.
#    Менять выход имеет смысл только когда YouTube перестал отвечать именно
#    этому адресу.
#
#  * Смена IP без перевыпуска сессии бесполезна: PO-token и visitor_data
#    привязаны к адресу, с которого выпускались. Поэтому переключение — это
#    всегда пара действий: записать новый прокси в active.env и пересоздать
#    companion со сносом кэша сессии.
#
#  * Кандидат проверяется ДО переключения. Иначе смена выхода могла бы
#    оставить companion вообще без работающего egress, а следующая попытка
#    случилась бы только через MIN_INTERVAL.
#
#  * Бэкофф обязателен. Если причина не в IP (сменился BotGuard, лежит
#    провайдер прокси), ротация не поможет ни на одном выходе, а цикл
#    «переключение → минт → отказ» сожжёт весь пул за минуты. Отсюда
#    MIN_INTERVAL между ротациями, порог из двух неудачных проверок подряд и
#    COOLDOWN, после которого адрес возвращается в пул. Та же логика, что у
#    бэкенда для bot-check'а (_BOT_CHECK_TTL).
#
#  * Пароли в лог не попадают: везде печатается только ip:port.
set -Eeuo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/root/music-service/invidious}"
# Список прокси и файл активного выхода (последний генерируется скриптом и
# читается compose как env_file).
LIST="${LIST:-$COMPOSE_DIR/proxy-pool/proxies.list}"
ACTIVE="${ACTIVE:-$COMPOSE_DIR/proxy-pool/active.env}"
# Тот же адрес для бэкенда: ссылки googlevideo привязаны к IP выхода, который
# их выдал, поэтому аудио надо качать через тот же прокси (STREAM_PROXY_FILE в
# docker-compose бэкенда, читается по mtime без перезапуска).
STREAM_URL_FILE="${STREAM_URL_FILE:-$COMPOSE_DIR/proxy-pool/stream-proxy/active.url}"
# Контейнер Redis музыкального сервиса: после смены выхода кэш резолва держит
# ссылки, привязанные к ПРЕЖНЕМУ адресу, и до истечения TTL (_RESOLVE_TTL, 3ч)
# каждая из них отдавала бы 403. Пусто — сброс не выполняется.
REDIS_CONTAINER="${REDIS_CONTAINER:-music_redis}"
# Тот же инстанс, что в INVIDIOUS_API_BASE музыкального сервиса, но с точки
# зрения хоста (в .env бэкенда он через host.docker.internal).
INVIDIOUS_URL="${INVIDIOUS_URL:-http://127.0.0.1:3050}"
STATE_DIR="${STATE_DIR:-/var/lib/invidious-proxy-rotate}"
# Пауза, после которой отправленный «отдыхать» прокси снова становится
# кандидатом: блок по IP снимается сам, и выжигать пул навсегда не нужно.
COOLDOWN="${COOLDOWN:-3600}"
# Минимум между двумя ротациями. Ниже 5 минут смысла нет: companion после
# пересоздания сам тратит десятки секунд на выпуск сессии, и следующая
# проверка иначе застанет его в процессе и посчитает это отказом.
MIN_INTERVAL="${MIN_INTERVAL:-600}"
# Сколько проверок подряд должны провалиться перед вмешательством. Единичный
# промах бывает и на здоровом выходе (битый ролик, сетевой блип).
FAIL_THRESHOLD="${FAIL_THRESHOLD:-2}"
# Ролики для проверки Invidious: два разных, чтобы реально недоступный не
# читался как блокировка.
PROBE_IDS="${PROBE_IDS:-dQw4w9WgXcQ b31YP1yrAZQ}"
# Ролик для проверки самого прокси (watch-страница). Нужен один и заведомо
# живой: проверяется не он, а реакция YouTube на адрес.
VERIFY_ID="${VERIFY_ID:-dQw4w9WgXcQ}"
UA="${UA:-Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36}"

# В stderr, а не stdout: stdout функций уходит в подстановку команд, и
# попавший туда лог сломал бы разбор. В journal оба потока идут одинаково.
log() { printf '%s rotate: %s\n' "$(date -Is)" "$*" >&2; }
die() { log "$*"; exit 1; }

compose() {
  docker compose -f docker-compose.prod.yml -f docker-compose.proxy.yml "$@"
}
# Процентное кодирование логина и пароля: они уходят в URL, и любой из
# символов @ : / ? # % в пароле иначе разъехался бы с его структурой (пароль
# с '@' превратил бы часть его в имя хоста).
urlenc() {
  local s="$1" out="" c i
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

# Разбирает proxies.list в строки «label<TAB>url<TAB>limit_bytes». label (ip:port) годится для
# логов и имён файлов состояния, url содержит пароль и в лог не выводится.
# IPv6 не поддержан намеренно: двоеточия в адресе неотличимы от разделителей
# формата, а провайдеры отдают IPv4.
parse_list() {
  [[ -f "$LIST" ]] || die "нет файла со списком прокси: $LIST (см. proxies.list.example)"
  local line spec quota host port user pass limit_bytes
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"                     # комментарий в конце строки
    line="${line//[$' \t\r']/}"            # пробелы и CRLF, если файл из Windows
    [[ -z "$line" ]] && continue
    quota=""
    if [[ "$line" == *'|'* ]]; then
      spec="${line%%|*}"
      quota="${line#*|}"
      line="$spec"
    fi
    IFS=':' read -r host port user pass <<<"$line"
    if [[ -z "$host" || -z "$port" ]]; then
      log "строка списка не разобрана, пропускаю: ${line:0:24}…"
      continue
    fi
    limit_bytes="$(quota_bytes "$quota")" || {
      log "лимит прокси ${host}:${port} не разобран: ${quota} (ожидается 100GB)"
      continue
    }
    if [[ -n "$user" ]]; then
      printf '%s:%s\thttp://%s:%s@%s:%s\t%s\n' \
        "$host" "$port" "$(urlenc "$user")" "$(urlenc "$pass")" "$host" "$port" "$limit_bytes"
    else
      printf '%s:%s\thttp://%s:%s\t%s\n' "$host" "$port" "$host" "$port" "$limit_bytes"
    fi
  done <"$LIST"
}

# Лимит в строке пула: 100GB, 500MB, 1TB. Пустой лимит = безлимитный (-1).
quota_bytes() {
  local value="${1:-}" number unit multiplier
  [[ -z "$value" || "$value" == "-" || "$value" == "unlimited" ]] && { printf '%s' -1; return 0; }
  value="${value^^}"
  if [[ "$value" =~ ^([0-9]+)(B|KB|MB|GB|TB)?$ ]]; then
    number="${BASH_REMATCH[1]}"
    unit="${BASH_REMATCH[2]:-B}"
    case "$unit" in
      B) multiplier=1;; KB) multiplier=1000;; MB) multiplier=1000000;;
      GB) multiplier=1000000000;; TB) multiplier=1000000000000;;
    esac
    printf '%s' "$(( number * multiplier ))"
    return 0
  fi
  return 1
}

traffic_key() {
  printf 'invidious:proxy-traffic:%s:%s' "$(date -u +%Y-%m)" "$1"
}

traffic_used() {
  local value
  [[ -n "$REDIS_CONTAINER" ]] || { printf '0'; return 0; }
  value="$(docker exec "$REDIS_CONTAINER" redis-cli --raw GET "$(traffic_key "$1")" 2>/dev/null || true)"
  [[ "$value" =~ ^[0-9]+$ ]] && printf '%s' "$value" || printf '0'
}

format_bytes() {
  local n="${1:-0}"
  if (( n >= 1000000000000 )); then printf '%sTB' "$(( n / 1000000000000 ))"
  elif (( n >= 1000000000 )); then printf '%sGB' "$(( n / 1000000000 ))"
  elif (( n >= 1000000 )); then printf '%sMB' "$(( n / 1000000 ))"
  elif (( n >= 1000 )); then printf '%sKB' "$(( n / 1000 ))"
  else printf '%sB' "$n"; fi
}

# Имя файла состояния для прокси: ip:port → ip_port.
key() { printf '%s' "${1//:/_}"; }

# Активный выход по данным active.env — только label, без пароля.
active_label() {
  local url
  url="$(active_url)" || return 1
  url="${url#*://}"            # отбрасываем схему
  printf '%s' "${url##*@}"     # и креды, если они есть
}

active_url() {
  [[ -f "$ACTIVE" ]] || return 1
  local url
  url="$(sed -n 's/^HTTPS_PROXY=//p' "$ACTIVE" | head -n1)"
  [[ -n "$url" ]] || return 1
  printf '%s' "$url"
}
# Отдаёт ли Invidious аудио-формат хотя бы по одному пробному ролику. Это
# ровно то, что нужно бэкенду; всё остальное (порт открыт, контейнер healthy)
# ничего не говорит о состоянии сессии.
probe_invidious() {
  local id
  for id in $PROBE_IDS; do
    if curl -sf --max-time 20 "${INVIDIOUS_URL}/api/v1/videos/${id}" \
      | grep -q '"type":"audio'; then
      return 0
    fi
  done
  return 1
}

# Обслуживает ли YouTube этот прокси. playabilityStatus:OK на watch-странице —
# признак, что адрес не в блоке (при блоке приходит LOGIN_REQUIRED /
# «Sign in to confirm you're not a bot» либо запрос вовсе не проходит).
# Это НЕ проверка выпуска PO-token: BotGuard-челлендж так не воспроизвести,
# но отсечь заведомо мёртвый адрес до переключения этого достаточно.
verify_proxy() {
  local url="$1" body
  body="$(curl -s --max-time 25 -x "$url" -A "$UA" \
    "https://www.youtube.com/watch?v=${VERIFY_ID}" 2>/dev/null)" || return 1
  grep -q -E '"playabilityStatus":\{"status":"OK"' <<<"$body"
}

# Перезаписывает active.env. В файле пароль, поэтому режим задаём явно (0600):
# на umask окружения, из которого запущен таймер, полагаться нельзя. compose
# читает файл от root.
write_active() {
  local url="$1" label="$2" tmp
  tmp="$(mktemp "${ACTIVE}.XXXXXX")"
  chmod 600 "$tmp"
  {
    printf '# Активный исходящий прокси invidious-companion.\n'
    printf '# Файл ГЕНЕРИРУЕТСЯ rotate.sh — правки затираются при ротации.\n'
    printf '# Менять выход: rotate.sh --activate N (список — proxies.list).\n'
    printf '# Выход: %s, назначен %s\n' "$label" "$(date -Is)"
    # Регистр дублируется: разные рантаймы смотрят на разный вариант, дешевле
    # задать оба, чем отлаживать «прокси игнорируется».
    printf 'HTTP_PROXY=%s\nHTTPS_PROXY=%s\nhttp_proxy=%s\nhttps_proxy=%s\n' \
      "$url" "$url" "$url" "$url"
  } >"$tmp"
  # mv, а не запись на месте: compose не должен прочитать файл на середине.
  mv "$tmp" "$ACTIVE"
}

# Тот же адрес — бэкенду, для скачивания аудио с googlevideo. Отдельным файлом
# в отдельном каталоге: в контейнер бэкенда монтируется только он, и туда не
# должен попасть весь proxies.list с паролями остальных прокси.
write_stream_url() {
  local url="$1" label="$2" dir tmp
  dir="$(dirname "$STREAM_URL_FILE")"
  if ! mkdir -p "$dir" 2>/dev/null; then
    log "ВНИМАНИЕ: нет каталога ${dir} — бэкенд продолжит качать напрямую и получит 403"
    return 0
  fi
  tmp="$(mktemp "${STREAM_URL_FILE}.XXXXXX")"
  chmod 600 "$tmp"
  {
    printf '# Выход для скачивания googlevideo: %s, назначен %s\n' "$label" "$(date -Is)"
    printf '# ГЕНЕРИРУЕТСЯ rotate.sh. Читается бэкендом (STREAM_PROXY_FILE).\n'
    printf '%s\n' "$url"
  } >"$tmp"
  mv "$tmp" "$STREAM_URL_FILE"
  log "выход для стриминга записан в $(basename "$STREAM_URL_FILE")"
}

# Кэш резолва хранит ссылки, привязанные к прежнему выходу: после смены адреса
# каждая из них отдаст 403, пока не истечёт TTL. Сбрасываем сразу — иначе
# «переключились, а музыка всё равно не играет» на несколько часов.
flush_resolve_cache() {
  [[ -n "$REDIS_CONTAINER" ]] || return 0
  if ! docker exec "$REDIS_CONTAINER" redis-cli ping >/dev/null 2>&1; then
    log "ВНИМАНИЕ: ${REDIS_CONTAINER} недоступен — кэш ссылок не сброшен (403 до 3ч)"
    return 0
  fi
  local n
  # $NF, а не $1: redis-cli печатает «7» при перенаправленном stdout и
  # «(integer) 7» в TTY-режиме — суммируем последнее поле в обоих случаях.
  n="$(docker exec "$REDIS_CONTAINER" sh -c \
    'redis-cli --scan --pattern "ytdlp:resolve:v2:*" | xargs -r -n100 redis-cli del' \
    2>/dev/null | awk '{s+=$NF} END {print s+0}')"
  log "кэш резолва сброшен (ключей: ${n:-0})"
}

# Пересоздаёт companion со сносом кэша сессии, чтобы PO-token выпустился
# заново — уже с текущего адреса. Контейнер удаляем целиком, а не restart: том
# с кэшем youtube.js занят даже остановленным контейнером, и docker volume rm
# на нём упал бы.
reissue_session() {
  compose rm -sf invidious-companion >/dev/null
  local vol
  while read -r vol; do
    [[ -n "$vol" ]] || continue
    docker volume rm "$vol" >/dev/null && log "кэш сессии ${vol} удалён"
  done < <(docker volume ls -q --filter name=companioncache)
  compose up -d invidious-companion >/dev/null
  log "companion пересоздан, сессия выпускается заново"
}
cooling() {  # прокси «отдыхает»? (истёкшие метки чистит expire_cooldowns)
  [[ -f "$STATE_DIR/cool.$(key "$1")" ]]
}

# После неудачного выпуска токена не перевыпускаем companion бесконечно на том же выходе.
session_reissued() {
  [[ -f "$STATE_DIR/session-reissued.$(key "$1")" ]]
}

mark_session_reissued() {
  printf '%s\n' "$(date +%s)" >"$STATE_DIR/session-reissued.$(key "$1")"
}

clear_session_reissued() {
  rm -f "$STATE_DIR/session-reissued.$(key "$1")"
}

expire_cooldowns() {
  local f ts srv now; now="$(date +%s)"
  shopt -s nullglob
  for f in "$STATE_DIR"/cool.*; do
    ts="$(cat "$f" 2>/dev/null || echo 0)"
    if (( now - ts >= COOLDOWN )); then
      srv="${f##*/cool.}"
      rm -f "$f"
      log "прокси ${srv//_/:} снова в пуле (отдыхал $(( (now - ts) / 60 )) мин)"
    fi
  done
  shopt -u nullglob
}

# Первый прокси из списка, который не отдыхает, не является текущим и реально
# обслуживается YouTube. Печатает «label<TAB>url».
pick_candidate() {
  local current="$1" label url limit used remaining best="" best_remaining=-1
  while IFS=$'\t' read -r label url limit; do
    [[ "$label" == "$current" ]] && continue
    limit="${limit:--1}"
    used="$(traffic_used "$label")"
    if (( limit >= 0 && used >= limit )); then
      log "кандидат ${label} исчерпал лимит ($(format_bytes "$used")/${limit}B)"
      continue
    fi
    if cooling "$label"; then
      log "кандидат ${label} ещё отдыхает — пропускаю"
      continue
    fi
    if verify_proxy "$url"; then
      if (( limit < 0 )); then remaining=9223372036854775807; else remaining=$(( limit - used )); fi
      if (( remaining > best_remaining )); then
        best="${label}"$'\t'"${url}"
        best_remaining="$remaining"
      fi
    else
      log "кандидат ${label} не проходит: YouTube не отдаёт playabilityStatus OK"
    fi
  done < <(parse_list)
  [[ -n "$best" ]] || return 1
  printf '%s\n' "$best"
}

# Назначение выхода: запись файла + перевыпуск сессии. Общий путь для --activate
# и для автоматической ротации, чтобы эти два сценария не разъезжались.
switch_to() {
  local label="$1" url="$2"
  clear_session_reissued "$label"
  write_active "$url" "$label"
  write_stream_url "$url" "$label"
  log "активный выход → ${label}"
  reissue_session
  # После companion: до этого момента резолв всё равно не работал, а сброшенный
  # раньше кэш успел бы наполниться ссылками прежнего выхода.
  flush_resolve_cache
}

mkdir -p "$STATE_DIR"
cd "$COMPOSE_DIR"

# ───────────────────────── ручные режимы ─────────────────────────
case "${1:-}" in
  --activate)
    n="${2:-}"
    [[ "$n" =~ ^[0-9]+$ && "$n" -ge 1 ]] || die "usage: $0 --activate N   (N — номер строки в $LIST, с 1)"
    entry="$(parse_list | sed -n "${n}p")"
    [[ -n "$entry" ]] || die "в списке нет прокси №${n}"
    IFS=$'\t' read -r label url <<<"$entry"
    # Проверяем, но не блокируем: раз выход назначен руками, решение за
    # оператором — скрипт лишь предупреждает, что адрес выглядит битым.
    if verify_proxy "$url"; then
      log "${label}: YouTube отвечает playabilityStatus OK"
    else
      log "ВНИМАНИЕ: ${label} не проходит проверку YouTube — назначаю по вашему указанию"
    fi
    rm -f "$STATE_DIR/cool.$(key "$label")"
    switch_to "$label" "$url"
    exit 0
    ;;
  --status)
    now="$(date +%s)"
    cur="$(active_label || true)"
    printf 'активный выход: %s\n' "${cur:-НЕ НАЗНАЧЕН (нет $ACTIVE)}"
    printf 'промахов подряд: %s   последняя ротация: %s\n' \
      "$(cat "$STATE_DIR/fails" 2>/dev/null || echo 0)" \
      "$(ts="$(cat "$STATE_DIR/last_rotate" 2>/dev/null || echo 0)"; \
         (( ts > 0 )) && date -Is -d "@$ts" || echo нет)"
    i=0
    while IFS=$'\t' read -r label _ limit; do
      i=$(( i + 1 )); mark=""
      [[ "$label" == "$cur" ]] && mark=" ← активный"
      if f="$STATE_DIR/cool.$(key "$label")"; [[ -f "$f" ]]; then
        left=$(( COOLDOWN - (now - $(cat "$f")) ))
        (( left < 0 )) && left=0
        mark+=" (отдыхает ещё $(( left / 60 )) мин)"
      fi
      used="$(traffic_used "$label")"
      if [[ "${limit:--1}" -ge 0 ]]; then
        mark+=" [трафик: $(format_bytes "$used")/$(format_bytes "$limit")]"
      else
        mark+=" [трафик: $(format_bytes "$used")/безлимит]"
      fi
      printf '  %2d. %s%s\n' "$i" "$label" "$mark"
    done < <(parse_list)
    exit 0
    ;;
  "") : ;;                      # авто-режим, продолжаем
  *) die "неизвестный аргумент: $1   (см. шапку файла)" ;;
esac

# ─────────────────────────── авто-режим ───────────────────────────
now="$(date +%s)"
expire_cooldowns

cur_label="$(active_label || true)"
cur_url="$(active_url || true)"
if [[ -z "$cur_url" ]]; then
  die "активный выход не назначен ($ACTIVE отсутствует) — запустите $0 --activate 1"
fi

active_limit=-1
while IFS=$'\t' read -r label _ limit; do
  if [[ "$label" == "$cur_label" ]]; then
    active_limit="${limit:--1}"
    break
  fi
done < <(parse_list)
active_used="$(traffic_used "$cur_label")"
quota_exhausted=0
if (( active_limit >= 0 && active_used >= active_limit )); then
  quota_exhausted=1
  log "выход ${cur_label} исчерпал месячный лимит ($(format_bytes "$active_used")/$(format_bytes "$active_limit"))"
fi

if (( ! quota_exhausted )) && probe_invidious; then
  clear_session_reissued "$cur_label"
  echo 0 >"$STATE_DIR/fails"
  exit 0
fi

if (( quota_exhausted )); then
  fails="$FAIL_THRESHOLD"
else
  fails=$(( $(cat "$STATE_DIR/fails" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" >"$STATE_DIR/fails"
  log "Invidious не отдаёт аудио-форматы (подряд: ${fails})"
fi

if (( ! quota_exhausted && fails < FAIL_THRESHOLD )); then
  log "ждём подтверждения на следующем запуске"
  exit 0
fi

last="$(cat "$STATE_DIR/last_rotate" 2>/dev/null || echo 0)"
if (( ! quota_exhausted && now - last < MIN_INTERVAL )); then
  log "вмешательство было $(( (now - last) / 60 )) мин назад (< ${MIN_INTERVAL}с) — держим бэкофф"
  exit 0
fi

# Сначала выясняем, в IP ли дело: если YouTube всё ещё обслуживает текущий
# адрес, менять выход незачем — виновата сессия, её и перевыпускаем.
if (( ! quota_exhausted )) && verify_proxy "$cur_url" && ! session_reissued "$cur_label"; then
  log "выход ${cur_label} у YouTube не в блоке — дело в сессии, меняю только её"
  # Файл для бэкенда пишем и здесь: выход не сменился, но при первой установке
  # (или если каталог появился позже) файла может ещё не быть.
  write_stream_url "$cur_url" "$cur_label"
  reissue_session
  flush_resolve_cache
  mark_session_reissued "$cur_label"
  echo "$now" >"$STATE_DIR/last_rotate"
  echo 0 >"$STATE_DIR/fails"
  exit 0
fi

if (( ! quota_exhausted )) && session_reissued "$cur_label"; then
  log "повторный выпуск сессии на ${cur_label} не помог — ищу другой выход"
else
  log "выход ${cur_label} YouTube больше не обслуживает — ищу замену"
fi
if ! entry="$(pick_candidate "$cur_label")"; then
  # Ничего не меняем: рабочего кандидата нет, а переключение «наугад» лишь
  # оставило бы companion без egress до следующего запуска таймера. Бэкенд в
  # это время работает через yt-dlp (см. _resolve_audio).
  log "ВНИМАНИЕ: в пуле нет прокси, который обслуживается YouTube — оставляю ${cur_label}"
  echo "$now" >"$STATE_DIR/last_rotate"
  exit 1
fi

IFS=$'\t' read -r new_label new_url <<<"$entry"
echo "$now" >"$STATE_DIR/cool.$(key "$cur_label")"
log "${cur_label} отправлен отдыхать на $(( COOLDOWN / 60 )) мин"
switch_to "$new_label" "$new_url"
echo "$now" >"$STATE_DIR/last_rotate"
echo 0 >"$STATE_DIR/fails"
