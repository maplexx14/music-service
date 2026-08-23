#!/usr/bin/env bash
# Выбирает живой выход из пула для МЕТАДАННЫХ SoundCloud и пишет его в
# stream-proxy/soundcloud.url (SOUNDCLOUD_PROXY_FILE в docker-compose).
#
# Зачем отдельно от rotate.sh: тот назначает выход для скачивания googlevideo и
# крутит вокруг него весь Invidious-стек (квоты, cooldown, сброс кэша ссылок,
# перезапуск companion). Здесь ничего этого не нужно — прокси нужен только
# затем, что провайдер режет SoundCloud целиком: soundcloud.com не открывается,
# а api-v2 отдаёт 403 даже с валидным client_id, и поиск возвращает пусто,
# потратив 15 секунд. Само аудио SoundCloud к IP выхода не привязано и идёт
# напрямую, так что квоту этот прокси почти не тратит — только JSON.
#
#   ./pick-soundcloud-proxy.sh            # оставить текущий, если он ещё жив
#   ./pick-soundcloud-proxy.sh --force    # выбрать заново
#
# Бэкенд перечитывает файл по mtime, перезапускать контейнер не нужно.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIST="${LIST:-$HERE/proxies.list}"
OUT="${OUT:-$HERE/stream-proxy/soundcloud.url}"
PROBE_URL="${PROBE_URL:-https://soundcloud.com/}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-12}"

FORCE=0
if [[ "${1:-}" == "--force" ]]; then FORCE=1; fi

log() { printf '%s pick-sc-proxy: %s\n' "$(date -Is)" "$*" >&2; }
die() { log "$*"; exit 1; }

# Процентное кодирование логина и пароля — как в rotate.sh: они уходят в URL, и
# '@' или ':' в пароле иначе разъехались бы со структурой адреса.
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

# «host:port<TAB>user<TAB>pass» на строку. Формат тот же, что у rotate.sh:
# host:port[:user:pass][|квота]; квота здесь не нужна и отбрасывается.
parse_list() {
  [[ -f "$LIST" ]] || die "нет файла со списком прокси: $LIST (см. proxies.list.example)"
  local line host port user pass
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line//[$' \t\r']/}"
    line="${line%%|*}"
    [[ -z "$line" ]] && continue
    IFS=':' read -r host port user pass <<<"$line"
    [[ -n "$host" && -n "$port" ]] || { log "строка не разобрана, пропускаю: ${line:0:24}…"; continue; }
    printf '%s:%s\t%s\t%s\n' "$host" "$port" "${user:-}" "${pass:-}"
  done <"$LIST"
}

# 200 с soundcloud.com через прокси — ровно то, что нужно для скрейпа client_id.
probe() {
  local label="$1" user="$2" pass="$3" code
  local args=(-sS -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT"
              --proxy "http://$label" -L)
  if [[ -n "$user" ]]; then args+=(--proxy-user "$user:$pass"); fi
  code="$(curl "${args[@]}" "$PROBE_URL" 2>/dev/null || true)"
  [[ "$code" == "200" ]]
}

current_label() {
  [[ -f "$OUT" ]] || return 1
  local url
  # Одним awk, а не grep|head: под set -o pipefail закрытый head роняет grep
  # по SIGPIPE, и «текущий выход» переставал определяться через раз.
  url="$(awk 'NF && $1 !~ /^#/ { print $1; exit }' "$OUT")"
  [[ -n "$url" ]] || return 1
  url="${url#*://}"        # схема
  printf '%s' "${url##*@}" # креды, если они есть
}

write_out() {
  local url="$1" label="$2" dir tmp
  dir="$(dirname "$OUT")"
  mkdir -p "$dir" || die "нет каталога $dir"
  tmp="$(mktemp "${OUT}.XXXXXX")"
  chmod 600 "$tmp"
  {
    printf '# Выход для метаданных SoundCloud: %s, назначен %s\n' "$label" "$(date -Is)"
    printf '# ГЕНЕРИРУЕТСЯ pick-soundcloud-proxy.sh. Читается бэкендом (SOUNDCLOUD_PROXY_FILE).\n'
    printf '%s\n' "$url"
  } >"$tmp"
  mv "$tmp" "$OUT"
  log "выход для SoundCloud записан в $(basename "$OUT"): $label"
}

mapfile -t entries < <(parse_list)
[[ ${#entries[@]} -gt 0 ]] || die "в $LIST нет ни одной записи"

# Живой текущий выход не трогаем: смена прокси без нужды только лишний повод
# для нового client_id и лишний шум в логах.
if (( ! FORCE )); then
  if keep="$(current_label)"; then
    for entry in "${entries[@]}"; do
      IFS=$'\t' read -r label user pass <<<"$entry"
      if [[ "$label" == "$keep" ]] && probe "$label" "$user" "$pass"; then
        log "текущий выход $label ещё жив — оставляю (--force чтобы сменить)"
        exit 0
      fi
    done
    log "текущий выход $keep больше не годится (не отвечает либо выбыл из пула) — выбираю новый"
  fi
fi

for entry in "${entries[@]}"; do
  IFS=$'\t' read -r label user pass <<<"$entry"
  if probe "$label" "$user" "$pass"; then
    host="${label%%:*}"; port="${label##*:}"
    if [[ -n "$user" ]]; then
      write_out "http://$(urlenc "$user"):$(urlenc "$pass")@${host}:${port}" "$label"
    else
      write_out "http://${host}:${port}" "$label"
    fi
    exit 0
  fi
  log "$label не отвечает"
done

die "ни один прокси из пула не открывает $PROBE_URL — SoundCloud останется недоступен"
