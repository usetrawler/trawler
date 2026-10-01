#!/bin/sh
set -u
fail=0
result() { if [ "$1" = 0 ]; then echo "ok   $2"; else echo "FAIL $2"; fail=1; fi; }
browser_uid=$(id -u browser)
setpriv --reuid=node --regid=node --init-groups env TRAWLER_RUNNER_TOKEN=isolation-check-token sleep 60 &
runner=$!
sleep 1
setpriv --reuid=browser --regid=browser --clear-groups cat /proc/$runner/environ >/dev/null 2>&1; result $(( $? == 0 )) "browser cannot read the runner's environment"
setpriv --reuid=browser --regid=browser --clear-groups dd if=/proc/$runner/mem of=/dev/null bs=1 count=1 skip=4194304 2>/dev/null; result $(( $? == 0 )) "browser cannot read the runner's memory"
setpriv --reuid=browser --regid=browser --clear-groups ls /proc/$runner/fd >/dev/null 2>&1; result $(( $? == 0 )) "browser cannot list the runner's open files"
kill $runner
as_node() { setpriv --reuid=node --regid=node --init-groups "$@"; }
as_node sudo -n -u root id >/dev/null 2>&1; result $(( $? == 0 )) "node cannot become root through sudo"
as_node sudo -n -u egress /usr/local/libexec/trawler-chromium-as-browser --version >/dev/null 2>&1; result $(( $? == 0 )) "node cannot run the launcher as another user"
as_node sudo -n -u browser /bin/sh -c id >/dev/null 2>&1; result $(( $? == 0 )) "node cannot run anything else as browser"
as_node sudo -n -u browser -- /usr/local/libexec/trawler-chromium-as-browser --version >/dev/null 2>&1; result $? "node can start Chromium as browser"
cd /app && as_node env HOME=/home/node TRAWLER_RUNNER_TOKEN=isolation-check-token node "$(dirname "$0")/isolation-check.mjs" "$browser_uid" || fail=1
exit $fail
