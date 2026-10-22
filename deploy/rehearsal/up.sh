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

# shellcheck source=lib.sh
. "$here/lib.sh"
export MAKA_CLOUD_ENV_FILE="$work/server.env"

# Compose reads the server's env file before it runs anything, so it exists first.
cp "$here/server.env" "$work/server.env"

guard_rehearsal
compose build

# The settings are made the way an operator makes them: "maka-cloud setup --from-env" runs in the
# server's image, makes the owner's invite in the data volume and fills in everything not asked,
# keeping what server.env already sets (the stand-ins as the APIs, the agent account). It writes
# as the image's user, so the directory it writes to is handed to that user and back again.
mkdir -p "$work/setup"
as_image_root() {
  compose run --rm --no-deps -T --user 0 --entrypoint "$1" -v "$work/setup:/setup" maka-cloud "${@:2}"
}
cp "$work/server.env" "$work/setup/server.env"
as_image_root chown -R node:node /setup
compose run --rm --no-deps -T -v "$work/setup:/setup" \
  -e MAKA_CLOUD_SETUP_DOMAIN=localhost -e MAKA_CLOUD_SETUP_MACHINE=m_rehearsal0000000000000000 \
  maka-cloud setup --from-env --no-verify --settings /setup/server.env --names /setup/names.env \
  > "$work/setup.txt" || { grep -v '^Your sign-in token' "$work/setup.txt" >&2; exit 1; }
as_image_root chown -R "$(id -u):$(id -g)" /setup
grep -v '^Your sign-in token' "$work/setup.txt"
token="$(sed -n 's/^Your sign-in token[^:]*: //p' "$work/setup.txt")"
rm -f "$work/setup.txt"
if [ -z "$token" ]; then
  echo "up.sh: setup made no invite" >&2
  exit 1
fi
umask 077
printf '%s' "$token" > "$work/token"
cp "$work/setup/server.env" "$work/server.env"
rm -rf "$work/setup"

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
MAKA_REHEARSAL_OPS=$here/ops.sh
MAKA_REHEARSAL_DIR=$work
ENV
echo "the stack is up behind Caddy: https://$app (settings in $work/env)"
