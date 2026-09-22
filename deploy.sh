#!/usr/bin/env sh
set -eu

cd /opt/ntrip-load-console

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Engine and the Compose plugin first." >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from defaults. Review /opt/ntrip-load-console/.env after deployment."
fi

docker compose up -d --build --remove-orphans
docker compose ps
