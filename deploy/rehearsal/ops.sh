#!/usr/bin/env bash
# What the flow does to the Compose stack that up.sh brought up: stop | start | restart | backup |
# backups | restore NAME. A host that runs the server some other way (systemd) has its own script
# with the same words; the flow only calls MAKA_REHEARSAL_OPS.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MAKA_CLOUD_ENV_FILE="${MAKA_REHEARSAL_DIR:?set MAKA_REHEARSAL_DIR to the directory up.sh used}/server.env"

compose() {
  docker compose -f "$here/../compose.yaml" -f "$here/compose.yaml" \
    --env-file "$here/compose.env" "$@"
}
# The server's own commands, run in a container of its image against its volumes (the server stopped).
maka() { compose run --rm --no-deps -T maka-cloud "$@"; }

case "${1:-}" in
  stop) compose stop maka-cloud ;;
  start) compose start maka-cloud ;;
  restart) compose restart maka-cloud ;;
  backup) maka backup ;;
  backups) maka backups ;;
  restore) maka restore "${2:?restore needs the name of a backup}" ;;
  *) echo "usage: ops.sh stop | start | restart | backup | backups | restore NAME" >&2; exit 2 ;;
esac
