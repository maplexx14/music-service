FROM python:3.11-slim

WORKDIR /app
ENV PYTHONPATH=/app

# Install system dependencies (ffmpeg is used for AAC transcoding and acoustic analysis).
# nodejs — JS-рантайм для yt-dlp: без него расшифровка n-sig/cipher
# googlevideo-ссылок невозможна, все JS-клиенты YouTube (web*, tv*, mweb)
# отдают 0 пригодных форматов, и yt-dlp пишет "No supported JavaScript runtime
# could be found ... some formats may be missing". Экстракция без рантайма
# объявлена deprecated, поэтому рантайм ставим в образ, а не полагаемся на
# фолбэк-клиенты.
RUN apt-get update && apt-get install -y \
    gcc \
    postgresql-client \
    ffmpeg \
    nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Expose port
EXPOSE 8000

# Run the application (docker-compose.yml overrides this with its own command,
# GUNICORN_WORKERS below only applies when the image is run standalone)
CMD gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w ${GUNICORN_WORKERS:-8} -b 0.0.0.0:8000 --forwarded-allow-ips=*
