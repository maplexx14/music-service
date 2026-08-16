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
