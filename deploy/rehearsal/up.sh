#!/usr/bin/env bash
# Builds the images, makes an invite, brings the stack up behind Caddy and waits until it is
# healthy through the proxy, over TLS, on all three names. Everything it writes goes in
# $MAKA_REHEARSAL_DIR (default: a new temporary directory, printed at the end):
#
#   server.env   the server's settings, with the sandbox map for the invite
#   token        the invite's token (a secret of this rehearsal only)
#   ca.crt       the root certificate of Caddy's own authority
#   env          the settings the flow reads (source it, or pass the file to the flow)
#
# Nothing live: the model and the sandbox are the stand-ins in stubs.mjs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="${MAKA_REHEARSAL_DIR:-$(mktemp -d)}"
mkdir -p "$work"
work="$(cd "$work" && pwd)"

compose() {
  docker compose -f "$here/../compose.yaml" -f "$here/compose.yaml" \
    --env-file "$here/compose.env" "$@"
}
export MAKA_CLOUD_ENV_FILE="$work/server.env"

# Compose reads the server's env file before it runs anything, so it exists first.
{ cat "$here/server.env"; echo "MAKA_CLOUD_SANDBOXES='{}'"; } > "$work/server.env"

compose build

# The invite lives in the server's data volume, so it is made there before the first start.
compose run --rm --no-deps --entrypoint node maka-cloud \
  packages/cloud-server/dist/cli.js invite create --invites /data/invites.db --label rehearsal \
  > "$work/invite.txt"
invite="$(awk '/^inviteId:/ { print $2 }' "$work/invite.txt")"
token="$(awk '/^token:/ { print $2 }' "$work/invite.txt")"
if [ -z "$invite" ] || [ -z "$token" ]; then
  echo "up.sh: the invite could not be made" >&2
  exit 1
fi
rm -f "$work/invite.txt"
umask 077
printf '%s' "$token" > "$work/token"
{ cat "$here/server.env"; echo "MAKA_CLOUD_SANDBOXES='{\"$invite\":\"m_rehearsal0000000000000000\"}'"; } \
  > "$work/server.env"

compose up -d --wait --wait-timeout 180

# Caddy makes its authority when it starts; its root certificate is what the flow trusts.
for _ in $(seq 1 30); do
  if compose cp proxy:/data/caddy/pki/authorities/local/root.crt "$work/ca.crt" 2> /dev/null; then
    break
  fi
  sleep 1
done
[ -s "$work/ca.crt" ] || { echo "up.sh: Caddy made no root certificate" >&2; exit 1; }

app="$(sed -n 's/^MAKA_CLOUD_APP_NAME=//p' "$here/compose.env")"
mcp="$(sed -n 's/^MAKA_CLOUD_MCP_NAME=//p' "$here/compose.env")"
models="$(sed -n 's/^MAKA_CLOUD_MODELS_NAME=//p' "$here/compose.env")"
for name in "$app" "$mcp" "$models"; do
  # --resolve: no DNS involved, whatever the resolver does with .localhost.
  for _ in $(seq 1 30); do
    if curl -fsS --cacert "$work/ca.crt" --resolve "$name:443:127.0.0.1" \
      -o /dev/null "https://$name/healthz" 2> /dev/null; then
      break
    fi
    sleep 1
  done
done
# The app name serves the web app and /healthz; the other two reach the server's MCP and gateway
# ports, which answer 401 or 404 without a token, never a TLS or connection error.
curl -fsS --cacert "$work/ca.crt" --resolve "$app:443:127.0.0.1" "https://$app/healthz" | grep -q '"ok"'
curl -fsS --cacert "$work/ca.crt" --resolve "$app:443:127.0.0.1" "https://$app/" | grep -qi '<html'
for name in "$mcp" "$models"; do
  status="$(curl -sS --cacert "$work/ca.crt" --resolve "$name:443:127.0.0.1" \
    -o /dev/null -w '%{http_code}' "https://$name/")"
  case "$status" in 4??) ;; *) echo "up.sh: https://$name/ answered $status" >&2; exit 1 ;; esac
done

cat > "$work/env" <<ENV
MAKA_REHEARSAL_URL=https://$app
MAKA_REHEARSAL_TOKEN_FILE=$work/token
MAKA_REHEARSAL_CA=$work/ca.crt
MAKA_REHEARSAL_RESOLVE=127.0.0.1
MAKA_REHEARSAL_CONTROL_URL=http://127.0.0.1:9102
MAKA_REHEARSAL_DIR=$work
ENV
echo "the stack is up behind Caddy: https://$app (settings in $work/env)"
