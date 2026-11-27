#!/bin/sh
# Генерирует /config.js из переменных окружения перед стартом nginx.
#
# Тот же механизм рантайм-конфига, что в деве (./docker-entrypoint.sh), но без
# npm install: образ уже собран. Позволяет менять API URL без пересборки —
# src/config.js читает window.__APP_CONFIG__ раньше, чем import.meta.env.
#
# Пустое значение — нормальный дефолт: config.js тогда отдаёт "/api", и
# фронтенд резолвит его относительно текущего origin.
set -eu

cat > /usr/share/nginx/html/config.js <<EOF
window.__APP_CONFIG__ = { VITE_API_URL: "${VITE_API_URL:-/api}" };
EOF

exec "$@"
