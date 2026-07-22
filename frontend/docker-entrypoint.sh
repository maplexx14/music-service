#!/bin/sh
set -e
npm install

# Генерация runtime config из переменных окружения.
mkdir -p /app/public
cat > /app/public/config.js << EOF
window.__APP_CONFIG__ = { VITE_API_URL: "${VITE_API_URL:-/api}" };
EOF

exec "$@"
