# Sourced by up.sh, down.sh and ops.sh: the one place that runs Compose for the rehearsal.
#
# The rehearsal never shares a Compose project, a volume or an image tag with a real deployment
# (deploy/compose.yaml names its project maka-cloud). A rehearsal on the owner's host must not be
# able to stop, restore or delete anything of the deployment that runs there, so:
#
#   - every call carries -p "$REHEARSAL_PROJECT", a name that starts with maka-rehearsal;
#   - guard_rehearsal reads the resolved configuration before any step that changes the stack and
#     refuses unless the project, every volume and every image are the rehearsal's own.

REHEARSAL_PROJECT="${MAKA_REHEARSAL_PROJECT:-maka-rehearsal}"
case "$REHEARSAL_PROJECT" in
  maka-rehearsal | maka-rehearsal-*) ;;
  *)
    echo "rehearsal: the Compose project must be maka-rehearsal or start with maka-rehearsal-, not '$REHEARSAL_PROJECT'" >&2
    exit 1
    ;;
esac

compose() {
  docker compose -p "$REHEARSAL_PROJECT" -f "$here/../compose.yaml" -f "$here/compose.yaml" \
    --env-file "$here/compose.env" "$@"
}

guard_rehearsal() {
  local config
  config="$(compose config --format json)" || {
    echo "rehearsal: the Compose configuration could not be read, so nothing was changed" >&2
    exit 1
  }
  printf '%s' "$config" | REHEARSAL_PROJECT="$REHEARSAL_PROJECT" node -e '
    const project = process.env.REHEARSAL_PROJECT;
    const fail = (why) => {
      console.error("rehearsal: refusing to touch the stack: " + why);
      process.exit(1);
    };
    let config;
    try {
      config = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    } catch {
      fail("the Compose configuration is not JSON");
    }
    if (config.name !== project) fail("the project is " + config.name + ", not " + project);
    const volumes = Object.values(config.volumes ?? {});
    if (volumes.length === 0) fail("the configuration has no volumes to check");
    for (const volume of volumes) {
      if (!String(volume.name).startsWith(project + "_")) {
        fail("volume " + volume.name + " is not one of the " + project + " project");
      }
    }
    for (const [name, service] of Object.entries(config.services ?? {})) {
      if (!/^maka-rehearsal(-[a-z]+)?:/.test(String(service.image))) {
        fail("service " + name + " uses the image " + service.image + ", not a rehearsal image");
      }
    }
  '
}
