# CI/CD

## CI

Pull requests and pushes to `main` run backend tests, frontend lint/build, and production Docker image builds.

## CD

After a successful CI run on `main`, the `CD` workflow deploys to the production GitHub Environment over SSH. It can also be started manually from Actions.

Configure these secrets in **Settings -> Environments -> production**:

- `DEPLOY_HOST` - VDS hostname or IP
- `DEPLOY_USER` - SSH user
- `DEPLOY_SSH_KEY` - private key allowed on the server
- `DEPLOY_PATH` - checkout path on the server (for example `/opt/music-service`)
- `DEPLOY_PORT` - optional SSH port, defaults to `22`

The server must have Docker Compose v2, a checkout of this repository, and a populated `.env.prod` at `DEPLOY_PATH`. The workflow fast-forwards the checkout to `origin/main`, validates the production Compose file, rebuilds images, and starts services with `docker compose up -d --remove-orphans`.

For a manual server deployment, run:

```bash
./deploy.sh
```

## Чистка диска

Диск прода небольшой (50 ГБ); образы после каждого деплоя, кэш стрима и
загрузки Soulseek растут без предела. Раз в час их чистит systemd-таймер
(`deploy/disk-cleanup.sh`, сроки хранения — в шапке скрипта). MinIO — архив
треков, скрипт его не трогает и только предупреждает в журнале, если места
мало даже после аварийного прохода.

Установка на сервере (один раз):

```bash
ln -sf /root/music-service/deploy/systemd/music-disk-cleanup.service /etc/systemd/system/
ln -sf /root/music-service/deploy/systemd/music-disk-cleanup.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now music-disk-cleanup.timer
```

Проверка без удаления: `DRY_RUN=1 bash deploy/disk-cleanup.sh`. Журнал:
`journalctl -u music-disk-cleanup.service -n 30`.
