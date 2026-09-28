#!/bin/sh
set -eu
port="${TRAWLER_EGRESS_PORT:-8899}"
token="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
env -i PATH="$PATH" HOME=/tmp NODE_ENV=production TRAWLER_EGRESS_PORT="$port" TRAWLER_EGRESS_TOKEN="$token" \
  setpriv --reuid=egress --regid=egress --clear-groups --no-new-privs node apps/runner/bin/egress-proxy.js &
export TRAWLER_EGRESS_PROXY="http://127.0.0.1:$port" TRAWLER_EGRESS_TOKEN="$token" HOME=/home/node
exec setpriv --reuid=node --regid=node --init-groups node apps/runner/bin/trawler-runner.js work --control-plane "$TRAWLER_CONTROL_PLANE"
