#!/bin/sh
# Entrypoint прод-nginx: подставляет ${DOMAIN} в шаблон и выбирает, какой
# конфиг развернуть — полный TLS или http-only заглушку.
#
# Зачем выбор: nginx отказывается стартовать, если ssl_certificate указывает
# на несуществующий файл, а сертификат нельзя получить без работающего nginx
# (ACME http-01 стучится на порт 80). Поэтому до первого выпуска поднимаемся
# по http, а после — перезапуск подхватывает TLS.
set -eu

: "${DOMAIN:?DOMAIN must be set (e.g. music.example.com)}"

CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
OUT="/etc/nginx/conf.d/app.conf"
TEMPLATES="/etc/nginx/templates"

# envsubst без списка переменных сожрал бы и nginx'овые $host/$scheme и т.п.
# Ограничиваем ровно теми, что подставляем сами.
render() {
    envsubst '${DOMAIN}' < "$1" > "$OUT"
}

if [ -f "${CERT_DIR}/fullchain.pem" ] && [ -f "${CERT_DIR}/privkey.pem" ]; then
    echo "nginx: сертификат для ${DOMAIN} найден — включаю HTTPS"
    render "${TEMPLATES}/app.conf.template"
else
    echo "nginx: сертификата для ${DOMAIN} нет — стартую в HTTP-режиме."
    echo "nginx: выпустите сертификат (./init-letsencrypt.sh), затем перезапустите контейнер."
    render "${TEMPLATES}/app-http-only.conf.template"
fi

# Базовый образ кладёт сюда свой дефолтный виртхост на listen 80 default_server;
# он перехватывал бы запросы и мешал нашему. Убираем.
rm -f /etc/nginx/conf.d/default.conf

nginx -t

# Фоновый reload: certbot обновляет сертификат в общем томе, но nginx держит
# старый в памяти до перечитывания конфига. Раз в 12 часов (с разбросом от
# certbot) проверяем и перечитываем — без этого продлённый сертификат
# начинает применяться только после ручного рестарта, а старый успевает
# протухнуть.
if [ "${1:-}" = "nginx" ]; then
    (
        while true; do
            sleep 12h
            nginx -s reload 2>/dev/null || true
        done
    ) &
fi

exec "$@"
