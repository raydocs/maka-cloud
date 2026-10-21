#!/usr/bin/env bash
# Takes the rehearsal stack down and deletes its volumes (the data, the backups, Caddy's authority).
# Only the maka-rehearsal project: guard_rehearsal refuses anything else (see lib.sh).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
export MAKA_CLOUD_ENV_FILE="${MAKA_REHEARSAL_DIR:-/dev/null}/server.env"
[ -f "$MAKA_CLOUD_ENV_FILE" ] || export MAKA_CLOUD_ENV_FILE="$here/server.env"
guard_rehearsal
compose down --volumes --remove-orphans
