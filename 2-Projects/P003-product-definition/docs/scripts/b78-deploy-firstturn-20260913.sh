#!/usr/bin/env bash
# B78 §3 步 3–5:只动 voice-worker-firstturn(单机灰度 unit)。
# 脚本内再核一遍锚与空闲;任一不符即退出、不改任何文件。生产 voice-worker-rust 只读对照。
# 用法(在 64.90 上以 root 跑):bash /root/b78-deploy-20260913.sh
set -uo pipefail
D=/root/rust-worker-firstturn
OLD=71e42ab0cf9d595ca799d0d62eff05fba43a5b857202c4ca6121a278c5a7b246
NEW=c2b84b2ec88b3bcfe7d69d767d43a5130b432d630e38a61a7f67d440bc9677c8
RB=$D/voice-rust-worker.rollback-71e42ab0-20260912T083440Z
U=voice-worker-firstturn
sha() { sha256sum "$1" | cut -c1-64; }
strip() { sed -r 's/\x1B\[[0-9;]*[mK]//g'; }
echo "== T0 $(date -u +%Y-%m-%dT%H:%M:%SZ)"
# ── 步 1 复核锚(B71/B78 真值) ──
P=$(systemctl show $U -p MainPID --value); [ "$P" = "2734957" ] || { echo "ABORT pid drift: $P"; exit 10; }
[ "$(sha $D/voice-rust-worker)" = "$OLD" ] || { echo "ABORT old exe sha drift"; exit 11; }
[ "$(sha $D/voice-rust-worker.new)" = "$NEW" ] || { echo "ABORT candidate sha drift"; exit 12; }
[ "$(stat -c %s $D/voice-rust-worker.new)" = "72569768" ] || { echo "ABORT candidate size"; exit 12; }
PP=$(systemctl show voice-worker-rust -p MainPID --value); PAE=$(systemctl show voice-worker-rust -p ActiveEnterTimestamp --value); PSHA=$(sha /proc/$PP/exe)
echo "prod before: pid=$PP ae=$PAE sha=$PSHA"
# ── 步 2 空闲守卫(带退出码;job request 与 process exiting 配平;只剩注册连接) ──
AE=$(systemctl show $U -p ActiveEnterTimestamp --value)
J=$(journalctl -u $U --since "$AE" --no-pager -o short-iso) || { echo "ABORT journal query failed"; exit 13; }
C=$(printf '%s\n' "$J" | strip)
a=$(printf '%s\n' "$C" | grep -c -F "job request" || true); b=$(printf '%s\n' "$C" | grep -c -F "process exiting" || true)
[ "$a" = "$b" ] || { echo "ABORT jobs not balanced request=$a exiting=$b"; exit 14; }
n=$(ss -tnp 2>/dev/null | grep -c "pid=$P," || true); [ "$n" -le 1 ] || { echo "ABORT extra tcp connections: $n"; exit 15; }
echo "idle: job request=$a process exiting=$b tcp=$n"
# ── 步 3 独立回滚件(不覆盖既有 .prev) ──
if [ -e "$RB" ]; then [ "$(sha "$RB")" = "$OLD" ] || { echo "ABORT existing rollback file differs"; exit 16; }; echo "rollback file pre-existing, sha ok"; else cp -p $D/voice-rust-worker "$RB" && echo "rollback file created"; fi
[ "$(sha "$RB")" = "$OLD" ] || { echo "ABORT rollback file sha"; exit 17; }
PREV_SHA=$(sha $D/voice-rust-worker.prev); PREV_SIZE=$(stat -c %s $D/voice-rust-worker.prev)
# ── 步 4 原子替换 + 只重启灰度 unit ──
mv -f $D/voice-rust-worker.new $D/voice-rust-worker || { echo "ABORT mv failed"; exit 18; }
if [ "$(sha $D/voice-rust-worker)" != "$NEW" ]; then echo "post-mv sha mismatch — restoring"; cp -p "$RB" $D/voice-rust-worker; exit 19; fi
echo "== T1 restart $(date -u +%Y-%m-%dT%H:%M:%SZ)"; systemctl restart $U; rc=$?; echo "restart rc=$rc"
# ── 步 5 核验:新 PID/exe SHA/ActiveEnter/registered;生产未动;.prev 保留 ──
sleep 3
systemctl show $U -p MainPID -p ActiveEnterTimestamp -p NRestarts -p ActiveState | tr '\n' ' '; echo
NP=$(systemctl show $U -p MainPID --value); { [ -n "$NP" ] && [ "$NP" != "0" ]; } || { echo "FAIL no MainPID"; exit 20; }
echo "new exe=$(readlink /proc/$NP/exe) sha=$(sha /proc/$NP/exe)"
NAE=$(systemctl show $U -p ActiveEnterTimestamp --value)
reg=0; J2=""; for i in $(seq 1 15); do J2=$(journalctl -u $U --since "$NAE" --no-pager -o short-iso 2>/dev/null) || { echo "journal2 query failed"; break; }; if printf '%s\n' "$J2" | strip | grep -q -F "registered"; then reg=1; break; fi; sleep 2; done
echo "registered=$reg (polled ${i}x2s)"
printf '%s\n' "$J2" | strip | grep -E "registered|panick|ERROR|error" | sed -E 's/room=[^ ]+/room=<redacted>/g' | cut -c1-170
echo "prod after: pid=$(systemctl show voice-worker-rust -p MainPID --value) ae=$(systemctl show voice-worker-rust -p ActiveEnterTimestamp --value) sha=$(sha /proc/$(systemctl show voice-worker-rust -p MainPID --value)/exe)"
echo "prev kept: sha=$(sha $D/voice-rust-worker.prev) size=$(stat -c %s $D/voice-rust-worker.prev) (was $PREV_SHA $PREV_SIZE)"
ls -l $D | awk 'NR>1{print $5,$9}'
# 步 6:注册失败**不自动回滚**,留给人决定(回滚= cp -p "$RB" $D/voice-rust-worker && systemctl restart $U)
[ "$reg" = "1" ] || { echo "NOT REGISTERED — 未自动回滚,回滚件 $RB 就绪"; exit 21; }
echo "== DONE $(date -u +%Y-%m-%dT%H:%M:%SZ)"
