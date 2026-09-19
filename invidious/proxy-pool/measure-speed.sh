#!/usr/bin/env bash
# Замер пропускной способности выходов пула. Только чтение: файлы пула не
# трогает, ротацию не запускает, контейнеры не пересоздаёт.
#
# Зачем: rotate.sh выбирает выход по остатку лимита (pick_candidate), а
# verify_proxy проверяет лишь то, что YouTube отвечает playabilityStatus OK и
# что googlevideo доступен, — ни одна из проверок не меряет скорость. Живой, но
# медленный выход остаётся активным до отказа или исчерпания лимита, и жалоба
# «треки грузятся долго» ни в одном журнале не отражается. Этот скрипт даёт
# цифры: сколько реально качается через активный выход, через прямой адрес VPS
# и (по желанию) через каждый адрес пула.
#
#   ./measure-speed.sh              # активный выход + прямой адрес (≈2 замера)
#   ./measure-speed.sh --all        # весь пул (по BYTES с адреса — трафик платный!)
#   BYTES=20000000 ./measure-speed.sh --all
#
# Трафик через платный прокси расходуется по-настоящему: по умолчанию 5 МБ на
# замер, так что прогон только активного выхода стоит ~10 МБ.
set -euo pipefail

# Числа печатаем через printf с плавающей точкой, а он в русской локали ждёт
# запятую в аргументе и падает на «0.17: invalid number». Локаль фиксируем: на
# вывод скрипта она всё равно не влияет.
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIST="${LIST:-$HERE/proxies.list}"
ACTIVE_URL_FILE="${ACTIVE_URL_FILE:-$HERE/stream-proxy/active.url}"
# Цель замера. speed.cloudflare.com отдаёт ровно запрошенное число байт и не
# режет датацентровые адреса; googlevideo для этого не годится — ссылки живут
# минуты и требуют резолва, то есть проверять пришлось бы по одной.
TARGET="${TARGET:-https://speed.cloudflare.com/__down?bytes=BYTES}"
BYTES="${BYTES:-5000000}"
TIMEOUT="${TIMEOUT:-90}"

ALL=0
[[ "${1:-}" == "--all" ]] && ALL=1

log() { printf '%s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

# Креды из URL в вывод не пускаем: в журнале им делать нечего.
mask() {
  local url="$1"
  if [[ "$url" == *"@"* ]]; then
    printf 'http://***@%s' "${url##*@}"
  else
    printf '%s' "$url"
  fi
}

# Один замер. Печатает «connect total speed code» через пробел: разбор через
# `IFS=$'\t' read` на bash 3.2 (bash macOS) поля не заполняет вообще, а пробел
# разделителем работает везде — числа из curl табов не содержат.
# Пустой proxy = прямой выход. Ветки продублированы намеренно: массив аргументов
# под `set -u` в bash 3.2 (а это bash с macOS, где скрипт тоже могут запустить)
# разворачивается в ошибку «unbound variable», а не в пустой список.
measure() {
  local proxy="$1" url out
  url="${TARGET//BYTES/$BYTES}"
  if [[ -n "$proxy" ]]; then
    out="$(curl -sS -o /dev/null --max-time "$TIMEOUT" --proxy "$proxy" \
      -w '%{time_connect} %{time_total} %{speed_download} %{http_code}' \
      "$url" 2>/dev/null)" || true
  else
    out="$(curl -sS -o /dev/null --max-time "$TIMEOUT" \
      -w '%{time_connect} %{time_total} %{speed_download} %{http_code}' \
      "$url" 2>/dev/null)" || true
  fi
  # Оборванное соединение curl иногда всё равно печатает шаблон -w, но частично
  # («0000» вместо четырёх полей) — поэтому считаем поля, а не код возврата.
  # shellcheck disable=SC2086
  set -- $out
  [[ $# -eq 4 ]] || out="0 0 0 000"
  printf '%s' "$out"
}

# Байты в удобоваримый вид и вердикт по скорости: аудио 128 kbps — это 16 КБ/с,
# так что даже 200 КБ/с хватает с запасом; медленным считаем то, что не тянет
# хотя бы 256 КБ/с (тогда 60-секундный буфер вперёд набирается больше 8 с).
report() {
  local label="$1" line="$2" conn total speed code verdict
  read -r conn total speed code <<<"$line"
  speed="${speed%%.*}"
  if [[ "$code" != "200" ]]; then
    verdict="не ответил (HTTP $code)"
  elif (( speed >= 1048576 )); then
    verdict="быстро"
  elif (( speed >= 262144 )); then
    verdict="терпимо"
  else
    verdict="МЕДЛЕННО"
  fi
  printf '%-24s connect=%6.3fs total=%7.3fs speed=%9s KB/s  HTTP %s  %s\n' \
    "$label" "${conn:-0}" "${total:-0}" "$(( speed / 1024 ))" "${code:-000}" "$verdict"
}

current_url() {
  [[ -f "$ACTIVE_URL_FILE" ]] || return 1
  awk 'NF && $1 !~ /^#/ { print $1; exit }' "$ACTIVE_URL_FILE"
}

echo "Цель: ${TARGET//BYTES/$BYTES}   по ${BYTES} байт на замер"
echo

report "прямой адрес VPS" "$(measure "")"

if url="$(current_url)"; then
  report "активный выход" "$(measure "$url")"
  printf '  (%s)\n' "$(mask "$url")"
else
  echo "активный выход не назначен ($ACTIVE_URL_FILE пуст) — аудио идёт напрямую"
fi

if (( ALL )); then
  [[ -f "$LIST" ]] || die "нет списка прокси: $LIST (см. proxies.list.example)"
  echo
  echo "Пул:"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="${line//[$' \t\r']/}"
    line="${line%%|*}"
    [[ -z "$line" ]] && continue
    # IFS ставим отдельной строкой, а не префиксом к read: на bash 3.2 (macOS)
    # `IFS=: read …` поля не заполняет — та же ловушка, что и с табами в report.
    host=""; port=""; user=""; pass=""
    saved_ifs="$IFS"; IFS=':'
    read -r host port user pass <<<"$line" || true
    IFS="$saved_ifs"
    [[ -n "$host" && -n "$port" ]] || continue
    if [[ -n "$user" ]]; then
      url="http://${user}:${pass}@${host}:${port}"
    else
      url="http://${host}:${port}"
    fi
    report "${host}:${port}" "$(measure "$url")"
  done <"$LIST"
fi
