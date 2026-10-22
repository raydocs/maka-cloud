#!/bin/sh
# Runs inside the `real-account-tests` image (deploy/Dockerfile), from /app/packages. A green run
# means the tests ran: node --test exits 0 on a glob that matches nothing, so each run's summary is
# checked, and the files that need the second account are named so that moving one fails here.
set -eu

for file in \
  cloud-runners/dist/__tests__/agent-user.test.js \
  cloud-playbooks/dist/coding/__tests__/check-real-account.test.js \
  cloud-playbooks/dist/coding/__tests__/checkout-real-account.test.js; do
  [ -f "$file" ] || { echo "real-account-tests: $file is missing" >&2; exit 1; }
done

run() {
  dir=$1
  shift
  out=$(mktemp)
  status=0
  (cd "$dir" && node --test "$@") >"$out" 2>&1 || status=$?
  cat "$out"
  [ "$status" -eq 0 ] || exit "$status"
  if ! grep -Eq '^# tests [1-9][0-9]*$' "$out"; then
    echo "real-account-tests: $dir ran no tests" >&2
    exit 1
  fi
}

run cloud-runners dist/__tests__/*.test.js
run cloud-playbooks dist/coding/__tests__/*.test.js
