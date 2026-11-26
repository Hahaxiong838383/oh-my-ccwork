#!/bin/bash
# Offline tests. All gateway, network and TV operations go to command stubs.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export RUNTIME_DIRECTORY="$work" DSH_PROBE_MAP="$work/map" LOG="$work/commands"
export PATH="$work:$PATH"
echo '["current","steady","burst","unconfirmed"]' > "$DSH_PROBE_MAP"
echo current > "$work/selector"
touch "$LOG"

cat > "$work/adb" <<'STUB'
#!/bin/bash
echo "adb $*" >> "$LOG"
case "$*" in
    *get-state*) [ -f "$RUNTIME_DIRECTORY/disconnected" ] && exit 1; echo device ;;
    *mResumedActivity*)
        if [ -f "$RUNTIME_DIRECTORY/view" ]; then cat "$RUNTIME_DIRECTORY/view"; exit 0; fi
        mode=$(cat "$RUNTIME_DIRECTORY/mode")
        [ "$mode" = unknown ] && exit 1
        [ "$mode" = off ] && exit 1
        pkg=com.dangbei.tvlauncher
        [ "$mode" = foreground ] && pkg=com.player.diyp2020
        [ "$mode" = buffering ] && pkg=org.smarttube.beta
        echo "mResumedActivity: ActivityRecord{abcdef u0 $pkg/.Player t1}"
        if [ "$mode" = buffering ]; then echo 'Sessions Stack - have 2 sessions:'
        else echo 'Sessions Stack - have 1 sessions:'; fi
        echo 'package=com.example.audio'
        echo 'active=true'
        echo "state=PlaybackState {state=2, position=0}"
        if [ "$mode" = buffering ]; then echo 'package=org.smarttube.beta'; echo 'active=true'; fi
        [[ "$mode" = background || "$mode" = buffering ]] && echo "state=PlaybackState {state=6, position=0}"
        ;;
    *vdec_status*)
        if [ -f "$RUNTIME_DIRECTORY/decoder" ]; then cat "$RUNTIME_DIRECTORY/decoder"; exit 0; fi
        echo 'frame count : 20'
        [ ! -f "$RUNTIME_DIRECTORY/advancing" ] || date +%s%N | sed 's/^/frame count : /'
        ;;
    *pidof*) echo 123 ;;
    *logcat*) echo 'SabrPoTokenError' ;;
    *) exit 7 ;;
esac
exit 0
STUB
cat > "$work/curl" <<'STUB'
#!/bin/bash
echo "curl $*" >> "$LOG"
case "$*" in
    *' -X PUT '*)
        name=$(echo "${!#}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
        echo "$name" > "$RUNTIME_DIRECTORY/selector"
        ;;
    *'/connections'*) cat "$RUNTIME_DIRECTORY/flows";;
    *'/proxies/proxy'*) printf '{"now":"%s"}\n' "$(cat "$RUNTIME_DIRECTORY/selector")" ;;
    *'/generate_204'*)
        case "$*" in
            *'127.0.0.1:1080'*) [ -f "$RUNTIME_DIRECTORY/reachable" ] && echo 204 || echo 000 ;;
            *'127.0.0.1:19202'*) echo 204 ;;
            *) echo 000 ;;
        esac ;;
    *'--range'*)
        case "$*" in
            *':19201 '*) size=300000 ;;
            *':19202 '*'0-26214399'*) size=3100000 ;;
            *':19202 '*) size=4200000 ;;
            *':19203 '*'0-26214399'*) size=200000 ;;
            *':19203 '*) size=7000000 ;;
            *':19204 '*) size=3500000 ;;
        esac
        if [[ -f "$RUNTIME_DIRECTORY/become-busy" && "$*" == *':19202 '* && "$*" == *'0-12582911'* ]]; then
            echo foreground > "$RUNTIME_DIRECTORY/mode"
        fi
        echo "206 $size 1.0" ;;
    *) exit 8 ;;
esac
STUB
cat > "$work/ip" <<'STUB'
#!/bin/bash
case "$*" in
    *'route get'*) echo '192.168.1.144 dev eth1 src 192.168.1.19' ;;
    *'route show'*) echo 'default via 192.168.1.1 dev eth1' ;;
    *'neigh show'*) cat "$RUNTIME_DIRECTORY/neigh" ;;
esac
STUB
cat > "$work/ping" <<'STUB'
#!/bin/bash
if [ "${!#}" = '192.168.1.1' ]; then [ ! -f "$RUNTIME_DIRECTORY/lan-down" ]; else exit 1; fi
STUB
cat > "$work/logger" <<'STUB'
#!/bin/sh
echo "log $*" >> "$LOG"
STUB
printf '#!/bin/sh\nexit 0\n' > "$work/sleep"
chmod +x "$work/ip" "$work/ping" "$work/adb" "$work/curl" "$work/logger" "$work/sleep"

for mode in foreground background unknown; do
    echo "$mode" > "$work/mode"
    if "$here/dsh-media-state.sh" idle; then exit 1; fi
    "$here/dsh-media-pick-exit.sh"
done
! grep -q '^curl ' "$LOG" || exit 1
grep -qx 'ExecCondition=/usr/local/sbin/dsh-media-state.sh idle' "$here/dsh-media-v6ab.conf"
echo idle > "$work/mode"
"$here/dsh-media-state.sh" idle
touch "$work/become-busy"
"$here/dsh-media-pick-exit.sh"
grep -q '0-26214399' "$LOG"
[ "$(cat "$work/mode")" = foreground ]
[ "$(cat "$work/selector")" = current ]
! grep -q ' -X PUT ' "$LOG" || exit 1

rm "$work/become-busy"
echo idle > "$work/mode"
"$here/dsh-media-pick-exit.sh"
[ "$(cat "$work/selector")" = steady ]
echo current > "$work/selector"
: > "$LOG"
echo foreground > "$work/mode"
touch "$work/reachable"
"$here/dsh-watch-exit.sh"
[ "$(cat "$work/dsh-watch.fails")" = 0 ]
rm "$work/reachable"
"$here/dsh-watch-exit.sh"
[ "$(cat "$work/dsh-watch.fails")" = 'current 1' ]
touch "$work/advancing"
"$here/dsh-watch-exit.sh"
[ "$(cat "$work/selector")" = current ]
rm "$work/advancing"
"$here/dsh-watch-exit.sh"
[ "$(cat "$work/selector")" = steady ]
[ "$(cat "$work/dsh-watch.fails")" = 0 ]
! grep -q -- '--range' "$LOG" || exit 1

"$here/dsh-st-guard.sh"
grep -q 'PoToken errors in the last 5 minutes: 1' "$LOG"
! grep -Eq 'force-stop|logcat -c|rm -rf|rm -f' "$LOG" || exit 1
touch "$work/disconnected"
echo off > "$work/mode"
echo '192.168.1.144 dev eth1 FAILED' > "$work/neigh"
echo '{"connections":[]}' > "$work/flows"
"$here/dsh-media-state.sh" idle
: > "$work/decoder"
"$here/dsh-media-state.sh" can-recover
echo current > "$work/selector"
echo 0 > "$work/dsh-pick-sweep.stamp"
"$here/dsh-media-pick-exit.sh"
[ "$(cat "$work/selector")" = steady ]
echo current > "$work/selector"
"$here/dsh-watch-exit.sh"
[ "$(cat "$work/selector")" = current ]
"$here/dsh-watch-exit.sh"
[ "$(cat "$work/selector")" = steady ]
echo '192.168.1.144 dev eth1 STALE' > "$work/neigh"
if "$here/dsh-media-state.sh" idle; then exit 1; fi
echo '192.168.1.144 dev eth1 FAILED' > "$work/neigh"
echo '{"connections":[{"metadata":{"sourceIP":"192.168.1.144"}}]}' > "$work/flows"
if "$here/dsh-media-state.sh" idle; then exit 1; fi
echo '{"connections":[]}' > "$work/flows"
touch "$work/lan-down"
if "$here/dsh-media-state.sh" idle; then exit 1; fi
rm "$work/disconnected" "$work/lan-down"
echo foreground > "$work/mode"
if "$here/dsh-media-state.sh" can-recover; then exit 1; fi
echo malformed > "$work/decoder"
if "$here/dsh-media-state.sh" can-recover; then exit 1; fi
echo 'No vdec.' > "$work/decoder"
if "$here/dsh-media-state.sh" can-recover; then exit 1; fi
echo buffering > "$work/mode"
"$here/dsh-media-state.sh" can-recover
cat > "$work/smart-error" <<'VIEW'
    mResumedActivity: ActivityRecord{62b597f u0 org.smarttube.beta/com.liskovsoft.smartyoutubetv2.tv.ui.playback.PlaybackActivity t5856}
  Sessions Stack - have 1 sessions:
      package=org.smarttube.beta
      active=true
      state=PlaybackState {state=7, position=569914, buffered position=569914, speed=0.0, updated=594991, actions=2360191}
VIEW
cp "$work/smart-error" "$work/view"
"$here/dsh-media-state.sh" can-recover
echo current > "$work/selector"
echo 'current 1' > "$work/dsh-watch.fails"
"$here/dsh-watch-exit.sh"
[ "$(cat "$work/selector")" = steady ]
for edit in 's/active=true/active=false/' 's/package=org.smarttube.beta/package=com.player.diyp2020/' \
            's@ u0 org.smarttube.beta/@ u0 com.player.diyp2020/@' 's/{state=7,/{state=3,/' \
            's/{state=7,/{state=2,/' '/state=PlaybackState/d' 's/have 1 sessions/have 2 sessions/'; do
    sed "$edit" "$work/smart-error" > "$work/view"
    if "$here/dsh-media-state.sh" can-recover; then exit 1; fi
done
sed 's/have 1 sessions/have 2 sessions/' "$work/smart-error" > "$work/view"
printf '      package=com.example.audio\n      active=true\n      state=PlaybackState {state=3, position=10}\n' >> "$work/view"
if "$here/dsh-media-state.sh" can-recover; then exit 1; fi
cp "$work/smart-error" "$work/view"
printf 'No vdec.\nframe count : 30\n' > "$work/decoder"
if "$here/dsh-media-state.sh" can-recover; then exit 1; fi
echo 'PASS foreground SmartTube state 7 with no decoder, confirmed outage recovery, wrong owner, background playback, inactive session and ambiguous samples'
echo 'PASS offline: failed L2 + live router + empty flows, ambiguous neighbour, existing flows, broken LAN, empty/malformed decoder, software player, declared no-decoder with SmartTube buffering'
echo 'PASS idle, foreground, background, unknown, mid-scan start, serial ranking, healthy path, advancing frames, lightweight failover, diagnostic guard'
