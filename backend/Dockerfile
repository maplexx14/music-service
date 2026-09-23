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
#
# fdkaac — HE-AAC v1 для низкобитрейтного варианта (64 kbps stereo вместо
# 128 kbps на медленных каналах). Нативный энкодер ffmpeg HE-AAC не умеет
# (`-profile:a aac_he` падает с Invalid argument), поэтому нужен libfdk-aac.
# В Debian пакет fdkaac лежит в contrib и тянет libfdk-aac2 из non-free, а
# python:3.11-slim подключает только main — отсюда правка источников.
# Правим ТОЛЬКО первый stanza (архив deb.debian.org): в debian-security
# компонентов contrib/non-free нет вовсе, и запрос их индексов уронил бы
# apt-get update на 404. ffmpeg остаётся: он делает 128k LC, acoustic-анализ
# и remux_hls_to_file.
RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i '0,/^Components: main$/s//Components: main contrib non-free/' \
            /etc/apt/sources.list.d/debian.sources; \
    else \
        printf 'deb http://deb.debian.org/debian bookworm main contrib non-free\n' \
            > /etc/apt/sources.list.d/contrib-nonfree.list; \
    fi

RUN apt-get update && apt-get install -y \
    gcc \
    postgresql-client \
    ffmpeg \
    fdkaac \
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
