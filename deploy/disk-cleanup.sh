#!/usr/bin/env bash
# Плановая чистка диска прод-сервера (запускается systemd-таймером, см.
# deploy/systemd/music-disk-cleanup.timer).
#
# Зачем: диск VPS 50 ГБ, и он уже дважды забивался до 100% (2026-09-30,
# 2026-10-01). На полном диске Postgres уходит в recovery mode, nginx не
# пишет кэш обложек и рвёт ответ — крупные обложки падают в заглушку.
# Растут четыре вещи:
#   - образы и build cache: каждый deploy.sh делает `compose build --pull`;
#   - ytdlp_cache: бэкенд держит LRU-потолок (YTDLP_CACHE_MAX_MB), но
#     применяет его только при записи нового файла, а .warm/.part-хвосты
#     прерванных загрузок никто не убирает;
#   - slskd_downloads: фоновый сборщик библиотеки (slsk_harvest) качает
#     больше 1 ГБ в час. Файлы до ARCHIVE_MAX_AUDIO_BYTES через минуты после
#     докачки уносятся в MinIO (adopt) — локальная копия дальше не нужна и
#     удаляется через SLSKD_ADOPTED_MIN. Крупные FLAC в MinIO не попадают;
#     их убирает retention самого slskd (slskd/slskd.yml) или срок ниже, а
#     бэкенд при пропаже просто скачает файл у пира заново;
#   - MinIO: архив треков. Его скрипт НЕ трогает — это не кэш, объекты
#     привязаны к записям в БД. При нехватке места только пишет предупреждение.
#
# Два режима. Обычный — удаляет только заведомо лишнее. Если после него
# свободно меньше MIN_FREE_GB, включается аварийный: сроки хранения короче.
#
# Ручки (переопределяются строками Environment= в юните):
#   VOLUME_PREFIX      префикс томов compose-проекта (по умолчанию music-service_)
#   MIN_FREE_GB        порог аварийного режима, ГБ (по умолчанию 6)
#   YTDLP_KEEP_DAYS    сколько дней держать файлы кэша стрима (14; аварийно 3)
#   SLSKD_KEEP_DAYS    сколько дней держать скачанное Soulseek (7; аварийно 1)
#   SLSKD_ADOPTED_MIN  через сколько минут удалять файлы, уже унесённые в
#                      MinIO (60: закачка сборщика ждёт до 45 мин, adopt —
#                      сразу после неё)
#   SLSKD_ADOPT_MAX_MB лимит размера архива, как ARCHIVE_MAX_AUDIO_BYTES у
#                      бэкенда (60): файлы крупнее в MinIO не уносятся
#   IMAGE_KEEP_HOURS   неиспользуемые образы и build cache моложе этого не
#                      трогаем — быстрый откат и пересборка (72; аварийно 0)
#   DRY_RUN=1          только показать, что было бы удалено

set -Eeuo pipefail

VOLUME_PREFIX="${VOLUME_PREFIX:-music-service_}"
MIN_FREE_GB="${MIN_FREE_GB:-6}"
YTDLP_KEEP_DAYS="${YTDLP_KEEP_DAYS:-14}"
SLSKD_KEEP_DAYS="${SLSKD_KEEP_DAYS:-7}"
SLSKD_ADOPTED_MIN="${SLSKD_ADOPTED_MIN:-60}"
SLSKD_ADOPT_MAX_MB="${SLSKD_ADOPT_MAX_MB:-60}"
IMAGE_KEEP_HOURS="${IMAGE_KEEP_HOURS:-72}"
DRY_RUN="${DRY_RUN:-0}"

log() { echo "disk-cleanup: $*"; }

free_gb() { df -BG --output=avail / | tail -n1 | tr -dc '0-9'; }

volume_dir() {
  docker volume inspect -f '{{.Mountpoint}}' "${VOLUME_PREFIX}$1" 2>/dev/null || true
}

# find с удалением; в DRY_RUN — только печать. Возвращает число файлов.
sweep() {
  local dir="$1"; shift
  [[ -n "$dir" && -d "$dir" ]] || { echo 0; return; }
  if [[ "$DRY_RUN" == "1" ]]; then
    find "$dir" "$@" -print | wc -l
  else
    find "$dir" "$@" -print -delete | wc -l
  fi
}

clean_pass() {
  local ytdlp_days="$1" slskd_days="$2" image_hours="$3"
  local ytdlp slskd n

  if [[ "$DRY_RUN" != "1" ]]; then
    local until_filter=()
    if (( image_hours > 0 )); then until_filter=(--filter "until=${image_hours}h"); fi
    docker builder prune -af "${until_filter[@]}" >/dev/null || log "builder prune failed"
    docker image prune -af "${until_filter[@]}" | tail -n1 || log "image prune failed"
  fi

  ytdlp="$(volume_dir ytdlp_cache)"
  # .warm — первые байты префетча, .part — брошенные загрузки: оба нужны
  # минуты, а не дни. Остальное — по возрасту.
  n=$(sweep "$ytdlp" -maxdepth 1 -type f \( -name '*.warm' -o -name '*.part' \) -mmin +720)
  log "ytdlp_cache: удалено warm/part: $n"
  n=$(sweep "$ytdlp" -maxdepth 1 -type f ! -name '*.part' -mtime "+$ytdlp_days")
  log "ytdlp_cache: удалено старше ${ytdlp_days} дн.: $n"

  slskd="$(volume_dir slskd_downloads)"
  # -size -Nk у find — строго меньше N КиБ-блоков, отсюда +1.
  n=$(sweep "$slskd" -type f -mmin "+$SLSKD_ADOPTED_MIN" -size "-$((SLSKD_ADOPT_MAX_MB * 1024 + 1))k")
  log "slskd_downloads: удалено унесённых в MinIO: $n"
  n=$(sweep "$slskd" -type f -mtime "+$slskd_days")
  log "slskd_downloads: удалено старше ${slskd_days} дн.: $n"
  if [[ "$DRY_RUN" != "1" && -n "$slskd" && -d "$slskd" ]]; then
    find "$slskd" -mindepth 1 -type d -empty -delete || true
  fi
}

before="$(free_gb)"
log "свободно до чистки: ${before} ГБ"

clean_pass "$YTDLP_KEEP_DAYS" "$SLSKD_KEEP_DAYS" "$IMAGE_KEEP_HOURS"

after="$(free_gb)"
if (( after < MIN_FREE_GB )); then
  log "свободно ${after} ГБ < ${MIN_FREE_GB} ГБ — аварийный режим"
  clean_pass 3 1 0
  after="$(free_gb)"
fi

log "свободно после чистки: ${after} ГБ"

if (( after < MIN_FREE_GB )); then
  minio="$(volume_dir minio_data)"
  log "ВНИМАНИЕ: места всё ещё мало. MinIO: $(du -sh "$minio" 2>/dev/null | cut -f1) — архив треков, чистится вручную" >&2
  exit 1
fi
