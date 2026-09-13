#!/usr/bin/env bash
# B84 生产 Session API 发布策略上线(aliyun-hk /opt/p003/server):只换一个文件 + 追加一个 env 键 + pm2 restart。
# 任一锚不符即退出不改。回滚:ONESHOT_FIRST_TURN_POLICY=off(或 allowlist)+ pm2 restart;或 cp 备份文件回去 + restart。
set -uo pipefail
D=/opt/p003/server; F=$D/src/routes/device-session.ts; NEWF=/tmp/device-session.b84.ts
OLD=eafe9820bb9b4f5c10fe3380b368bf18; NEW=504dd06265ca7a11d71d59dfcf297f63
TS=$(date -u +%Y%m%d-%H%M%S); BK=/opt/p003/_backup/$TS-b84-policy
echo "== T0 $(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ "$(md5sum $F | cut -c1-32)" = "$OLD" ] || { echo "ABORT prod file drift: $(md5sum $F | cut -c1-32)"; exit 10; }
[ "$(md5sum $NEWF | cut -c1-32)" = "$NEW" ] || { echo "ABORT staged file md5"; exit 11; }
grep -q '^ONESHOT_FIRST_TURN_POLICY=' $D/.env.local && { echo "ABORT policy key already present"; exit 12; }
grep -q '^ONESHOT_FIRST_TURN_AGENT_NAME=rust-worker-firstturn$' $D/.env.local || { echo "ABORT agent key not as expected"; exit 13; }
P0=$(pm2 pid p003-voice); echo "pm2 pid before=$P0"
mkdir -p "$BK" && chmod 700 "$BK" && cp -p "$F" "$BK/" && cp -p $D/.env.local "$BK/" && echo "backup: $BK ($(ls "$BK" | tr '\n' ' '))"
cp -p "$NEWF" "$F"
[ "$(md5sum $F | cut -c1-32)" = "$NEW" ] || { echo "ABORT copy failed — restoring"; cp -p "$BK/device-session.ts" "$F"; exit 14; }
printf '\n# B84 (2026-09-13) 首句合同发布策略: allowlist(默认,只灰度名单)|capability(OTA 到新版 APK 即自动具备 One-shot)|off(全局暂停=回滚开关);改后 pm2 restart p003-voice\nONESHOT_FIRST_TURN_POLICY=capability\n' >> $D/.env.local
echo "== T1 restart $(date -u +%Y-%m-%dT%H:%M:%SZ)"; cd $D && pm2 restart p003-voice >/dev/null; echo "pm2 restart rc=$?"
H=""; for i in $(seq 1 10); do sleep 2; H=$(curl -s -m 3 http://127.0.0.1:3001/health || true); [ "$H" = '{"status":"ok"}' ] && break; done; echo "health=$H (after ${i}x2s)"
pm2 jlist | python3 -c 'import json,sys; [print("pm2:",p["name"],"pid=",p["pid"],"status=",p["pm2_env"]["status"],"restarts=",p["pm2_env"]["restart_time"]) for p in json.load(sys.stdin) if p["name"]=="p003-voice"]'
[ "$H" = '{"status":"ok"}' ] || { echo "FAIL health — 回滚: cp -p $BK/device-session.ts $F; 删 .env.local 末两行; pm2 restart p003-voice"; exit 20; }
# 无凭据探针:401 = 路由已加载且执行到鉴权;不入流水、不碰真机 SN
code=$(curl -s -m 5 -o /tmp/b84-probe.out -w '%{http_code}' -X POST http://127.0.0.1:3001/v1/device/session -H 'content-type: application/json' -d '{"device_sn":"x","trace_id":"b84-probe"}'); echo "no-cred probe http=$code body=$(cut -c1-80 /tmp/b84-probe.out)"; rm -f /tmp/b84-probe.out
[ "$code" = "401" ] || { echo "FAIL probe"; exit 21; }
L=$(pm2 jlist | python3 -c 'import json,sys; print([p["pm2_env"]["pm_out_log_path"] for p in json.load(sys.stdin) if p["name"]=="p003-voice"][0])'); E="${L/-out./-error.}"
echo "--- 重启后 error 日志尾(应无 POLICY 告警/import 错)"; tail -n 30 "$E" | grep -iE 'POLICY|import|SyntaxError|TypeError|ReferenceError' | tail -n 5; echo "(end)"
echo "== DONE $(date -u +%Y-%m-%dT%H:%M:%SZ)"
