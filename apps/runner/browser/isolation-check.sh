#!/bin/sh
set -u
fail=0
result() { if [ "$1" = 0 ]; then echo "ok   $2"; else echo "FAIL $2"; fail=1; fi; }
launcher=/usr/local/libexec/trawler-chromium-as-browser
browser_uid=$(id -u browser)
as_node() { setpriv --reuid=node --regid=node --init-groups "$@"; }
as_browser() { setpriv --reuid=browser --regid=browser --clear-groups "$@"; }

setpriv --reuid=node --regid=node --init-groups env TRAWLER_RUNNER_TOKEN=isolation-check-token sleep 120 &
runner=$!
sleep 1
scope=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo 0)
if [ "$scope" = 0 ]; then
  address=$(as_node head -1 /proc/$runner/maps | cut -d- -f1)
  as_node dd if=/proc/$runner/mem of=/dev/null bs=1 count=1 iflag=skip_bytes skip=$((0x$address)) 2>/dev/null; result $? "node can read its own process's memory, so the next check is meaningful"
  as_browser dd if=/proc/$runner/mem of=/dev/null bs=1 count=1 iflag=skip_bytes skip=$((0x$address)) 2>/dev/null; result $(( $? == 0 )) "browser cannot read the runner's memory"
elif [ "${TRAWLER_REQUIRE_MEMORY_CHECK:-}" = 1 ]; then
  result 1 "the memory checks ran (ptrace_scope is $scope; set it to 0)"
else
  echo "skip memory checks: ptrace_scope $scope refuses them to every process that is not an ancestor (the hosted runner has 0)"
fi
[ "$(find / -xdev -perm -4000 -type f 2>/dev/null)" = /usr/bin/sudo ]; result $? "sudo is the only setuid program in the image"
as_browser cat /proc/$runner/environ >/dev/null 2>&1; result $(( $? == 0 )) "browser cannot read the runner's environment"
as_browser ls /proc/$runner/fd >/dev/null 2>&1; result $(( $? == 0 )) "browser cannot list the runner's open files"
as_browser kill -0 $runner 2>/dev/null; result $(( $? == 0 )) "browser cannot signal the runner"
kill $runner

[ "$(stat -c %U:%a $launcher /usr/local/bin/trawler-chromium /etc/sudoers.d/trawler-browser | tr '\n' ' ')" = "root:755 root:755 root:440 " ]; result $? "the launchers and the sudo rule belong to root and only root can change them"
rules=$(as_node sudo -n -l 2>/dev/null | tr ',' '\n' | sed 's/^ *//')
printf '%s\n' "$rules" | grep -qx 'env_reset' && ! printf '%s\n' "$rules" | grep -qx '!env_reset'; result $? "sudo resets the environment it passes to the browser"
as_node sudo -n -u root id >/dev/null 2>&1; result $(( $? == 0 )) "node cannot become root through sudo"
as_node sudo -n -u egress $launcher --version >/dev/null 2>&1; result $(( $? == 0 )) "node cannot run the launcher as another user"
as_node sudo -n -u browser /bin/sh -c id >/dev/null 2>&1; result $(( $? == 0 )) "node cannot run anything else as browser"
as_node env TRAWLER_RUNNER_TOKEN=isolation-check-token sudo -n -u browser -- $launcher --version >/dev/null 2>&1; result $? "node can start Chromium as browser"
for switch in --renderer-cmd-prefix=/bin/true --browser-subprocess-path=/bin/true -utility-cmd-prefix=/bin/true --gpu-launcher=/bin/true --remote-debugging-port=9222; do
  as_node sudo -n -u browser -- $launcher "$switch" --version >/dev/null 2>&1; result $(( $? != 64 )) "the launcher refuses $switch"
done

as_browser sh -c 'mkdir -p /tmp/left/locked /var/tmp/left /dev/shm/left && touch /tmp/left/locked/f /var/tmp/left/f /dev/shm/left/f /run/lock/left /var/lib/trawler-downloads/left && chmod 0500 /tmp/left/locked /tmp/left' 2>/dev/null
keyring_check=0
if setpriv --reuid=browser --regid=browser --init-groups keyctl add user trawler-left secret @u >/dev/null 2>&1; then
  keyring_check=1
  setpriv --reuid=browser --regid=browser --init-groups keyctl add user trawler-left-session secret @us >/dev/null 2>&1
  result $? "browser can leave keys in its user and user-session keyrings, so the next check is meaningful"
elif [ "${TRAWLER_REQUIRE_KEYRING_CHECK:-}" = 1 ]; then
  result 1 "the keyring checks ran (the kernel or seccomp refused add_key for browser)"
else
  echo "skip keyring checks: the kernel or seccomp refuses add_key for browser, so no key can be left there"
fi
as_browser ipcmk -M 4096 >/dev/null 2>&1 && as_browser ipcmk -Q >/dev/null 2>&1 && as_browser ipcmk -S 1 >/dev/null 2>&1; result $? "browser can leave shared memory, a queue and a semaphore, so the next check is meaningful"
setpriv --reuid=browser --regid=browser --clear-groups sleep 300 &
other=$!
sleep 1
as_node sudo -n -u browser -- $launcher --version >/dev/null 2>&1
kill -0 $other 2>/dev/null && [ -e /var/tmp/left/f ]; result $? "a launch leaves another browser of the same job running, with its files"
as_node /usr/local/bin/trawler-chromium --clean; result $? "node can clean the browser's user"
left=$(find /tmp /var/tmp /dev/shm /run/lock /dev/mqueue /var/lib/trawler-downloads -user browser 2>/dev/null | wc -l)
result $(( left != 0 )) "cleaning removes what the browser left in any writable directory, locked or not"
alive=$(for p in /proc/[0-9]*; do [ "$(stat -c %u "$p" 2>/dev/null)" = "$browser_uid" ] && ! grep -q '^State:[[:space:]]*Z' "$p/status" 2>/dev/null && echo "$p"; done | wc -l)
result $(( alive != 0 )) "cleaning ends every process the browser left running"
ipc=$(ipcs -a 2>/dev/null | awk -v u=browser '$3 == u' | wc -l)
result $(( ipc != 0 )) "cleaning removes the shared memory, queues and semaphores the browser left"
if [ "$keyring_check" = 1 ]; then
  setpriv --reuid=browser --regid=browser --init-groups sh -c 'keyctl search @u user trawler-left || keyctl search @us user trawler-left-session' >/dev/null 2>&1
  result $(( $? == 0 )) "cleaning removes the keys the browser left in its user and user-session keyrings"
fi

rm -f /tmp/isolation-check.pids /tmp/isolation-check.go
(cd /app && as_node env HOME=/home/node TRAWLER_RUNNER_TOKEN=isolation-check-token node "$(dirname "$0")/isolation-check.mjs" "$browser_uid") &
check=$!
for i in $(seq 1 300); do [ -s /tmp/isolation-check.pids ] && break; sleep 0.1; done
leaked=0; read_env=1; profiled=1; privileged=0; counted=0
for p in /proc/[0-9]*; do
  [ "$(stat -c %u "$p" 2>/dev/null)" = "$browser_uid" ] || continue
  grep -q '^State:[[:space:]]*Z' "$p/status" 2>/dev/null && continue
  counted=$((counted + 1))
  grep -q '^NoNewPrivs:[[:space:]]*1' "$p/status" 2>/dev/null || privileged=1
done
[ $counted -gt 0 ] && [ $privileged = 0 ]; result $? "every process running as browser has no_new_privs ($counted processes)"
for p in /proc/[0-9]*; do
  tr '\0' ' ' < "$p/cmdline" 2>/dev/null | grep -q "$launcher" || continue
  env=$(as_browser cat "$p/environ" 2>/dev/null | tr '\0' '\n') && [ -n "$env" ] && read_env=0
  printf '%s\n' "$env" | grep -q '^TRAWLER_' && leaked=1
done
for pid in $(cat /tmp/isolation-check.pids 2>/dev/null); do
  tr '\0' '\n' < /proc/$pid/cmdline 2>/dev/null | grep -q '^--user-data-dir=/tmp/trawler-browser\.[A-Za-z0-9]*/profile$' && profiled=0
done
result $read_env "the launcher's environment was read as browser, so the next check is meaningful"
[ -s /tmp/isolation-check.pids ]; result $? "the browser was open for inspection"
result $leaked "Chromium's environment holds no TRAWLER_ variable"
result $profiled "Chromium uses the launcher's own profile, not the runner's"
touch /tmp/isolation-check.go
wait $check || fail=1
exit $fail
