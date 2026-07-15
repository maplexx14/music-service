FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Entrypoint: reinstall deps on start (fixes stale node_modules when package.json changes via mount)
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]
# Serve a stable production build. Vite dev/HMR can reload an installed PWA
# whenever bind-mounted files change, which destroys the audio element.
CMD ["sh", "-c", "npm run build && npm run preview -- --host 0.0.0.0 --port 3000 --strictPort"]
