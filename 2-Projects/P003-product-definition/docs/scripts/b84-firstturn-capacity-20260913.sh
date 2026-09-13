#!/usr/bin/env bash
# B84 §5.4 (64.90) 灰度 firstturn 池 → 生产规格:WORKER_MAX_JOBS 2→10;MemoryHigh/Max 700M/900M → 1200M/1500M(drop-in 覆盖 unit 本体)。
# 二进制不动(c2b84b2e…)。空闲守卫过才 restart。回滚:cp env .bak 回去 + 删 drop-in + daemon-reload + restart。
set -uo pipefail
U=voice-worker-firstturn; D=/root/rust-worker-firstturn; ENVF=$D/rust-worker-firstturn.env; DI=/etc/systemd/system/$U.service.d/50-b84-capacity.conf
NEWSHA=c2b84b2ec88b3bcfe7d69d767d43a5130b432d630e38a61a7f67d440bc9677c8
sha() { sha256sum "$1" | cut -c1-64; }; strip() { sed -r 's/\x1B\[[0-9;]*[mK]//g'; }
echo "== T0 $(date -u +%Y-%m-%dT%H:%M:%SZ)"
P=$(systemctl show $U -p MainPID --value); [ "$P" = "2892651" ] || { echo "ABORT pid drift $P"; exit 10; }
[ "$(sha /proc/$P/exe)" = "$NEWSHA" ] || { echo "ABORT exe sha drift"; exit 11; }
grep -q '^WORKER_MAX_JOBS=2$' "$ENVF" || { echo "ABORT env MAX_JOBS not 2"; exit 12; }
[ -e "$DI" ] && { echo "ABORT drop-in exists"; exit 13; }
AE=$(systemctl show $U -p ActiveEnterTimestamp --value); J=$(journalctl -u $U --since "$AE" --no-pager -o short-iso) || { echo "ABORT journal"; exit 14; }
C=$(printf '%s\n' "$J" | strip); a=$(printf '%s\n' "$C" | grep -c -F "job request" || true); b=$(printf '%s\n' "$C" | grep -c -F "process exiting" || true)
[ "$a" = "$b" ] || { echo "ABORT jobs not balanced $a/$b"; exit 15; }
n=$(ss -tnp 2>/dev/null | grep -c "pid=$P," || true); [ "$n" -le 1 ] || { echo "ABORT tcp $n"; exit 16; }
echo "idle ok: jobs $a=$b tcp=$n"
BK=$ENVF.bak-b84-$(date -u +%Y%m%dT%H%M%SZ); cp -p "$ENVF" "$BK" && sed -i 's/^WORKER_MAX_JOBS=2$/WORKER_MAX_JOBS=10/' "$ENVF" && echo "env: $(grep -n '^WORKER_MAX_JOBS=' "$ENVF") (backup $BK)"
mkdir -p "$(dirname "$DI")" && printf '# B84 §5.4 (2026-09-13): firstturn 池升到生产规格(V1.1 全量设备走这里);覆盖 unit 本体的 700M/900M。回滚=删本文件+daemon-reload+restart\n[Service]\nMemoryHigh=1200M\nMemoryMax=1500M\n' > "$DI"
systemctl daemon-reload && echo "limits: $(systemctl show $U -p MemoryHigh -p MemoryMax --value | tr '\n' ' ')"
echo "== T1 restart $(date -u +%Y-%m-%dT%H:%M:%SZ)"; systemctl restart $U; echo "rc=$?"; sleep 3
NP=$(systemctl show $U -p MainPID --value); systemctl show $U -p MainPID -p ActiveEnterTimestamp -p ActiveState -p NRestarts | tr '\n' ' '; echo
echo "exe sha=$(sha /proc/$NP/exe)"; tr '\0' '\n' < /proc/$NP/environ | grep -E '^(WORKER_MAX_JOBS|AGENT_NAME)='; echo "audit keys in env (must be 0)=$(tr '\0' '\n' < /proc/$NP/environ | grep -c '^ONESHOT_AUDIT_CAPTURE' || true)"
reg=0; for i in $(seq 1 15); do NAE=$(systemctl show $U -p ActiveEnterTimestamp --value); if journalctl -u $U --since "$NAE" --no-pager 2>/dev/null | strip | grep -q -F registered; then reg=1; break; fi; sleep 2; done; echo "registered=$reg (${i}x2s)"
echo "prod rust: $(systemctl show voice-worker-rust -p MainPID -p ActiveEnterTimestamp --value | tr '\n' ' ')"
[ "$reg" = 1 ] || { echo "NOT REGISTERED — 手工决定回滚(env .bak 回写 + 删 $DI + daemon-reload + restart)"; exit 21; }
echo "== DONE $(date -u +%Y-%m-%dT%H:%M:%SZ)"
