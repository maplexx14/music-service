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

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
