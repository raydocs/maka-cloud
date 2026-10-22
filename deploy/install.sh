#!/bin/sh
# Installs maka-cloud on this host and starts it: the server and Caddy under Docker Compose.
#
#   curl -fsSL https://raw.githubusercontent.com/raydocs/maka-cloud/main/deploy/install.sh | sh
#
# or, from a checkout, ./deploy/install.sh. It checks the host, clones (or updates) the checkout,
# builds the images, runs the first-run wizard ("maka-cloud setup") and starts the stack. Run it
# again to update and restart; the settings are kept, and the wizard runs again only if you ask.
# It spends nothing: no task starts until someone posts a message.
#
# Settings (all optional):
#   MAKA_CLOUD_DIR    where the checkout lives (default /opt/maka-cloud)
#   MAKA_CLOUD_REF    the branch or tag to install (default main)
#   MAKA_CLOUD_REPO   the repository to clone (default https://github.com/raydocs/maka-cloud.git)
#   MAKA_CLOUD_SETUP  ask = run the wizard on a first install, and ask on later ones (default);
#                     always; never; or env = no questions, read the answers from the
#                     environment (see "maka-cloud setup" in docs/fork/deploy.md)
#
# The settings go to /etc/maka-cloud.env (mode 600, root only: it holds the keys) and the three
# names to /etc/maka-cloud.compose.env.

# Everything is in functions and runs from the last line, so a download cut short runs nothing.

set -eu

say() { printf '%s\n' "$*"; }
fail() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}

as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  elif command -v sudo > /dev/null 2>&1; then
    sudo "$@"
  else
    fail "this needs root: run it as root or install sudo"
  fi
}

check_host() {
  case "$(uname -s)" in
    Linux) ;;
    Darwin) say "macOS: fine for a trial; a server that others use belongs on Linux." ;;
    *) fail "maka-cloud runs on Linux (or macOS for a trial), not on $(uname -s)" ;;
  esac
  command -v git > /dev/null 2>&1 || fail "git is not installed"
  command -v docker > /dev/null 2>&1 \
    || fail "Docker is not installed: see https://docs.docker.com/engine/install/"
  as_root docker compose version > /dev/null 2>&1 \
    || fail "the Docker Compose plugin is not installed (docker compose version failed)"
  as_root docker info > /dev/null 2>&1 || fail "Docker is installed but not running"
}

fetch_checkout() {
  if [ -d "$DIR/.git" ]; then
    if [ -n "$(as_root git -C "$DIR" status --porcelain --untracked-files=no)" ]; then
      fail "$DIR has local changes; commit or remove them, then run this again"
    fi
    say "Updating $DIR to $REF"
    as_root git -C "$DIR" fetch --quiet origin "$REF"
    as_root git -C "$DIR" checkout --quiet --detach FETCH_HEAD
  elif [ -e "$DIR" ]; then
    fail "$DIR exists and is not a checkout; set MAKA_CLOUD_DIR to another place"
  else
    say "Cloning $REPO ($REF) into $DIR"
    as_root git clone --quiet --branch "$REF" "$REPO" "$DIR"
  fi
}

# Compose needs the three names and a settings file to read the compose file at all, even to build
# or to run the wizard; before the wizard has written them, stand-ins that are never served.
compose() {
  as_root env \
    MAKA_CLOUD_ENV_FILE="${COMPOSE_SETTINGS:-$SETTINGS}" \
    MAKA_CLOUD_APP_NAME="${APP_NAME:-setup.invalid}" \
    MAKA_CLOUD_MCP_NAME="${MCP_NAME:-setup.invalid}" \
    MAKA_CLOUD_MODELS_NAME="${MODELS_NAME:-setup.invalid}" \
    docker compose -f "$DIR/deploy/compose.yaml" "$@"
}

read_names() {
  [ -f "$NAMES" ] || return 0
  APP_NAME="$(as_root sed -n 's/^MAKA_CLOUD_APP_NAME=//p' "$NAMES")"
  MCP_NAME="$(as_root sed -n 's/^MAKA_CLOUD_MCP_NAME=//p' "$NAMES")"
  MODELS_NAME="$(as_root sed -n 's/^MAKA_CLOUD_MODELS_NAME=//p' "$NAMES")"
}

wants_setup() {
  case "$SETUP" in
    always | env) return 0 ;;
    never) return 1 ;;
    ask) ;;
    *) fail "MAKA_CLOUD_SETUP must be ask, always, never or env" ;;
  esac
  [ -f "$SETTINGS" ] || return 0
  [ -r /dev/tty ] || return 1
  printf 'Settings found in %s. Run the setup questions again? [y/N] ' "$SETTINGS" > /dev/tty
  read -r answer < /dev/tty || answer=
  case "$answer" in y | Y | yes) return 0 ;; *) return 1 ;; esac
}

run_setup() {
  # The wizard runs in the server's image as its unprivileged user (uid 1000) on a private copy of
  # the settings. That uid may be someone else's on this host, so the copy sits in a directory only
  # root can enter: the container is given the inner directory itself, nobody on the host reaches
  # it. The copy is put back root-only and removed, whatever happens.
  work="$(as_root mktemp -d)"
  trap 'as_root rm -rf "$work"' EXIT INT TERM
  as_root chmod 700 "$work"
  as_root mkdir -m 700 "$work/setup"
  [ -f "$SETTINGS" ] && as_root cp "$SETTINGS" "$work/setup/settings.env"
  [ -f "$NAMES" ] && as_root cp "$NAMES" "$work/setup/names.env"
  as_root chown -R 1000:1000 "$work/setup"
  as_root sh -c 'umask 077; : > "$1"' sh "$work/none.env"

  if [ "$SETUP" = env ]; then
    # The answers reach the container as its env file: never on a command line, where any user
    # of the host could read them, and sudo would drop them from the environment anyway. Single
    # quotes, so Compose takes each value as it is (a "$" in an address is not a variable).
    answers="MAKA_CLOUD_SETUP_DOMAIN MAKA_CLOUD_SETUP_MACHINE MAKA_CLOUD_SETUP_EMAIL
      ANTHROPIC_API_KEY OPENAI_API_KEY INSTABOX_API_KEY MAKA_GITHUB_TOKEN"
    for name in $answers; do
      eval "value=\${$name:-}"
      # shellcheck disable=SC2154 # set by the eval above
      case "$value" in *"'"*) fail "$name holds a single quote, which no setting may" ;; esac
    done
    for name in $answers; do
      eval "value=\${$name:-}"
      [ -n "$value" ] && printf "%s='%s'\n" "$name" "$value"
    done | as_root sh -c 'umask 077; cat > "$1"' sh "$work/none.env"
    COMPOSE_SETTINGS="$work/none.env" compose run --rm --no-deps -T -v "$work/setup:/setup" \
      maka-cloud setup --from-env --settings /setup/settings.env --names /setup/names.env
  else
    [ -r /dev/tty ] || fail "the setup questions need a terminal; or set MAKA_CLOUD_SETUP=env"
    COMPOSE_SETTINGS="$work/none.env" compose run --rm --no-deps -v "$work/setup:/setup" \
      maka-cloud setup --settings /setup/settings.env --names /setup/names.env < /dev/tty
  fi

  as_root install -m 600 -o root -g root "$work/setup/settings.env" "$SETTINGS"
  as_root install -m 600 -o root -g root "$work/setup/names.env" "$NAMES"
  as_root rm -rf "$work"
  trap - EXIT INT TERM
}

main() {
  DIR="${MAKA_CLOUD_DIR:-/opt/maka-cloud}"
  REF="${MAKA_CLOUD_REF:-main}"
  REPO="${MAKA_CLOUD_REPO:-https://github.com/raydocs/maka-cloud.git}"
  SETUP="${MAKA_CLOUD_SETUP:-ask}"
  SETTINGS=/etc/maka-cloud.env
  NAMES=/etc/maka-cloud.compose.env

  check_host
  fetch_checkout
  read_names

  say "Building the images (the first build takes a few minutes)"
  if [ -f "$SETTINGS" ]; then compose build --quiet; else COMPOSE_SETTINGS=/dev/null compose build --quiet; fi

  if wants_setup; then run_setup; fi
  [ -f "$SETTINGS" ] || fail "no settings in $SETTINGS: run this again and answer the setup questions"
  read_names

  say "Starting maka-cloud"
  compose --env-file "$NAMES" up -d --wait --wait-timeout 300
  compose exec -T maka-cloud node packages/cloud-host/dist/cli.js check > /dev/null \
    || fail "the server's settings do not pass its check: see the output of 'maka-cloud check'"

  say ""
  say "maka-cloud is running. Open https://$APP_NAME and sign in with the token setup printed."
  say "Point $APP_NAME, $MCP_NAME and $MODELS_NAME at this host if you have not; Caddy gets the"
  say "certificates once they resolve here. Settings: $SETTINGS. Runbook: $DIR/docs/fork/deploy.md"
}

main "$@"
