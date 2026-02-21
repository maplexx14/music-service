#!/bin/sh
set -e
npm install

# Генерация runtime config из переменных окружения (разные адреса фронта и бэкенда)
API_URL="${VITE_API_URL:-}"
if [ -n "$API_URL" ]; then
  mkdir -p /app/public
  cat > /app/public/config.js << EOF
window.__APP_CONFIG__ = { VITE_API_URL: "$API_URL" };
EOF
fi

exec "$@"
