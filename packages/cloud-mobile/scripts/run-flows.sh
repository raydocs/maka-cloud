#!/usr/bin/env bash
# Runs the Maestro flows on the device that is already booted, against the stack on this machine.
# Used by CI (.github/workflows/fork-cloud-mobile.yml); `run-flows.sh ios` or `run-flows.sh android`.
set -euo pipefail
platform="${1:?ios or android}"
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

case "$platform" in
  # The Android emulator reaches this machine as 10.0.2.2; the iOS simulator shares its network.
  android) server="http://10.0.2.2:${CLOUD_WEB_API_PORT:-4174}" ;;
  ios) server="http://localhost:${CLOUD_WEB_API_PORT:-4174}" ;;
  *) echo "unknown platform $platform" >&2; exit 2 ;;
esac

if [ "$platform" = android ]; then
  # A busy hosted emulator makes the launcher "not respond"; the box then covers the app mid-flow.
  adb shell settings put global hide_error_dialogs 1
  adb install -r android/app/build/outputs/apk/release/app-release.apk
fi

# Maestro runs a flow's scripts on this machine, not on the device, so they reach the control port here.
control="http://127.0.0.1:${CLOUD_WEB_CONTROL_PORT:-4175}"

mkdir -p e2e-output
status=0
for flow in first-visit:fresh sign-in-email:email decision:decision delivery:delivery; do
  name="${flow%%:*}"
  seed="${flow##*:}"
  token="$(node scripts/e2e-seed.mjs "http://127.0.0.1:${CLOUD_WEB_CONTROL_PORT:-4175}" "http://127.0.0.1:${CLOUD_WEB_API_PORT:-4174}" "$seed" | sed -n 's/^TOKEN=//p')"
  maestro test ".maestro/$name.yaml" \
    -e "SERVER=$server" -e "TOKEN=$token" -e "CONTROL=$control" -e "EMAIL=maka-$platform@example.com" \
    --format junit --output "e2e-output/$platform-$name.xml" \
    --test-output-dir "e2e-output/$platform-$name" || status=1
done
exit "$status"
