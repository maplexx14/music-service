#!/usr/bin/env bash
# Конвертация Netscape-cookies (экспорт браузера) в строку-заголовок Cookie
# для YOUTUBE_SESSION_COOKIES у invidious-companion.
#
# Companion принимает НЕ файл, а саму строку "name=value; name2=value2"
# (см. config.example.toml в его репозитории: [youtube_session] cookies = "").
# Образ distroless — entrypoint подменить нельзя, поэтому строка попадает в
# окружение контейнера через переменную YOUTUBE_SESSION_COOKIES, значение для
# которой берёт docker compose из сгенерированного companion-cookies.env.
#
# Источник — тот же файл, что ест бэкенд (YTDLP_COOKIEFILE:
# ../backend/secrets/ytdlp_cookies.txt): один экспорт кукиz обслуживает оба
# сервиса. Нужны только домены .youtube.com / .google.com (SIDCC, __Secure-*
# и пр.) — остальное (accounts.google.com, doubleclick и мусор) не помогает.
#
# Использование (на сервере):
#   proxy-pool/make-companion-cookies.sh            # создать/обновить env-файл
#   docker compose -f docker-compose.prod.yml up -d invidious-companion
#
# Смена куки: обновить backend/secrets/ytdlp_cookies.txt → снова запустить
# скрипт → up -d (перезапуск обязателен: сессия перевыпускается на старте).
set -Eeuo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
SRC="${SRC:-$COMPOSE_DIR/../backend/secrets/ytdlp_cookies.txt}"
OUT="${OUT:-$COMPOSE_DIR/companion-cookies.env}"

if [[ ! -f "$SRC" ]]; then
    echo "нет $SRC — экспортируйте куки браузера (Netscape-формат) туда" >&2
    exit 1
fi

# awk-часть: строки формата domain \t flag \t path \t secure \t expiry \t name \t value.
# Берём домены youtube.com/google.com и ТОЛЬКО имена из белого списка —
# сессионные куки Google-аккаунта. Реальный экспорт тащит с собой ~40
# мёртвых ST-*-кук (transfer-токены флоу входа) и аналитику (_ga, _gcl_au):
# заголовок раздувается до ~18КБ, и YouTube его режет. Пропускаем комментарии
# и пустые строки. Имя и значение — 6-е и 7-е поля.
header="$(awk -F'\t' '
    function allowed(name) {
        return name ~ /^(SID|HSID|SSID|SAPISID|APISID|LOGIN_INFO|SIDCC|PREF|NID|VISITOR_INFO1_LIVE|CONSISTENCY|__Secure-(1P|3P)APISID|__Secure-(1P|3P)SID|__Secure-(1P|3P)SIDCC|__Secure-(1P|3P)SIDTS|__Secure-(BUCKET|ROLLOUT_TOKEN|YENID|YNID))$/
    }
    /^#/ || NF < 7 { next }
    !allowed($6) { next }
    $1 ~ /\.youtube\.com$/ || $1 == "youtube.com" { keep[$6] = $7; next }
    $1 ~ /\.google\.com$/  || $1 == "google.com"  { keep[$6] = $7 }
    END {
        n = 0
        for (name in keep) {
            printf "%s%s=%s", (n ? "; " : ""), name, keep[name]
            n++
        }
        if (n == 0) exit 1
    }
' "$SRC")"

if [[ -z "$header" ]]; then
    echo "в $SRC не нашлось куки youtube.com/google.com — проверьте экспорт" >&2
    exit 1
fi

# Порядок не детерминирован (awk-ассоциативный массив) — не страшно, сервер
# куки не сортирует. Экранирование не нужно: значение не содержит переводов
# строки (Netscape-формат табличный) и запрещённых символов env-файла
# (проверено на реальных экспортах: значения base64/буквенно-цифровые).
umask 077
tmp="$(mktemp)"
printf '# Сгенерировано make-companion-cookies.sh — не коммитить (сессия Google).\n' >"$tmp"
printf 'YOUTUBE_SESSION_COOKIES=%s\n' "$header" >>"$tmp"
mv "$tmp" "$OUT"

echo "ок: $OUT, длина заголовка ${#header} байт, куки: $(printf '%s' "$header" | tr ';' '\n' | cut -d= -f1 | sed 's/^ *//' | sort | tr '\n' ' ')"
