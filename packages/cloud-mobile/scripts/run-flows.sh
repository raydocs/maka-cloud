#!/usr/bin/env bash
# Runs the Maestro flows on the device that is already booted, against the stack on this machine.
# Used by CI (.github/workflows/fork-cloud-mobile.yml); `run-flows.sh ios` or `run-flows.sh android`.
set -euo pipefail
platform="${1:?ios or android}"
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

case "$platform" in
  # The Android emulator reaches this machine as 10.0.2.2; the iOS simulator shares its network.
  android) server="http://10.0.2.2:4174" ;;
  ios) server="http://localhost:4174" ;;
  *) echo "unknown platform $platform" >&2; exit 2 ;;
esac

if [ "$platform" = android ]; then
  adb install -r android/app/build/outputs/apk/release/app-release.apk
fi

mkdir -p e2e-output
status=0
for flow in first-visit:fresh decision:decision; do
  name="${flow%%:*}"
  seed="${flow##*:}"
  token="$(node scripts/e2e-seed.mjs http://127.0.0.1:4175 http://127.0.0.1:4174 "$seed" | sed -n 's/^TOKEN=//p')"
  maestro test ".maestro/$name.yaml" \
    -e "SERVER=$server" -e "TOKEN=$token" \
    --format junit --output "e2e-output/$platform-$name.xml" \
    --test-output-dir "e2e-output/$platform-$name" || status=1
done
exit "$status"
