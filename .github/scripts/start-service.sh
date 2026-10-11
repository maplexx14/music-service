#!/usr/bin/env bash
# Поднимает контейнер сервиса для CI, перебирая зеркала образа.
#
# `services:` в workflow тянет образ один раз из одного реестра: и Docker Hub,
# и ECR Public режут анонимные pull'ы по IP общих раннеров GitHub, и тогда
# джоб падает на «toomanyrequests: Rate exceeded» ещё до первого шага. Здесь
# каждое зеркало пробуется с повторами и нарастающей паузой.
#
# Использование: start-service.sh <имя> <образ-на-Docker-Hub> <docker run args...>
# Образ — как на Docker Hub (postgres:15-alpine); зеркала подставляются сами.
set -euo pipefail

name="$1"
image="$2"
shift 2

mirrors=(
  "public.ecr.aws/docker/library/${image}"
  "mirror.gcr.io/library/${image}"
  "docker.io/library/${image}"
)

pulled=""
for mirror in "${mirrors[@]}"; do
  for attempt in 1 2 3; do
    if docker pull "$mirror"; then
      pulled="$mirror"
      break 2
    fi
    sleep $((attempt * 10))
  done
done

if [ -z "$pulled" ]; then
  echo "::error::Не удалось скачать $image ни с одного зеркала"
  exit 1
fi

docker run -d --name "$name" "$@" "$pulled"
