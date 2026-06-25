#!/usr/bin/env bash
#
# update_run.sh — rapid update & relaunch for a remote server.
# Fetches the latest main, then rebuilds and restarts the stack.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Updating main from git..."
git fetch origin main
git checkout main
git reset --hard origin/main

# Build the new images while the old containers keep running — no downtime
# during the (slow) build step.
echo "==> Building new images (old stack still serving)..."
docker compose build

# Recreate only the services whose image/config changed (backend, frontend).
# Mongo is untouched — no replica-set re-init, no transaction interruption — so
# downtime is just the few seconds it takes to swap the changed containers.
echo "==> Swapping in new containers..."
docker compose up -d

# Drop now-dangling old image layers freed by the rebuild. Scoped to this
# compose project so other running stacks' images are left alone.
echo "==> Pruning old images..."
docker image prune -f --filter "label=com.docker.compose.project=cryptobot"

echo "==> Done. Container status:"
docker compose ps
