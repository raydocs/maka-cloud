#!/usr/bin/env bash
# Takes the rehearsal stack down and deletes its volumes (the data, the backups, Caddy's authority).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MAKA_CLOUD_ENV_FILE="${MAKA_REHEARSAL_DIR:-/dev/null}/server.env"
[ -f "$MAKA_CLOUD_ENV_FILE" ] || export MAKA_CLOUD_ENV_FILE="$here/server.env"
docker compose -f "$here/../compose.yaml" -f "$here/compose.yaml" \
  --env-file "$here/compose.env" down --volumes --remove-orphans
