#!/usr/bin/env bash
# B89 生产 server 上线(aliyun-hk /opt/p003/server):换 3 个 ts + 新增 release.json + pm2 restart + health/401/后台 API 冒烟。锚不符即退、不改。
# 回滚:cp $BK/device-session.ts $BK/admin-data.ts /opt/p003/server/src/routes/; cp $BK/config-store.ts /opt/p003/server/src/; rm /opt/p003/server/release.json; pm2 restart p003-voice
# 开关层回滚:后台「清除后台覆盖」或 DELETE /api/admin/oneshot/policy(回落 env=capability);数据表 runtime_flag 只在 config.db,不影响其它表。
set -uo pipefail
D=/opt/p003/server; ST=/tmp/b89-stage; TS=$(date -u +%Y%m%d-%H%M%S); BK=/opt/p003/_backup/$TS-b89-oneshot-admin
m() { md5sum "$1" | cut -c1-32; }
echo "== T0 $(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ "$(m $D/src/routes/device-session.ts)" = "504dd06265ca7a11d71d59dfcf297f63" ] || { echo "ABORT device-session.ts drift $(m $D/src/routes/device-session.ts)"; exit 10; }
[ "$(m $D/src/routes/admin-data.ts)" = "be8ff379966893a3ced3f54aaf2a2d02" ] || { echo "ABORT admin-data.ts drift $(m $D/src/routes/admin-data.ts)"; exit 11; }
[ "$(m $D/src/config-store.ts)" = "9d4a75605d21a340694a865c696c919e" ] || { echo "ABORT config-store.ts drift $(m $D/src/config-store.ts)"; exit 12; }
[ -e $D/release.json ] && { echo "ABORT release.json already exists"; exit 13; }
[ "$(m $ST/config-store.ts)" = "4d95aef2c2db4adc29bb4cacb81b50ee" ] || { echo "ABORT staged config-store.ts"; exit 14; }
[ "$(m $ST/device-session.ts)" = "3feaa45bb7508b333324dbc9e24834bd" ] || { echo "ABORT staged device-session.ts"; exit 14; }
[ "$(m $ST/admin-data.ts)" = "43230d3caee6100c8d058cd07d416b7c" ] || { echo "ABORT staged admin-data.ts"; exit 14; }
[ "$(m $ST/release.json)" = "913a31d6f7f4be59ca2f18d9b2a039ba" ] || { echo "ABORT staged release.json"; exit 14; }
mkdir -p "$BK" && chmod 700 "$BK" && cp -p $D/src/routes/device-session.ts $D/src/routes/admin-data.ts $D/src/config-store.ts "$BK/" && echo "backup: $BK ($(ls "$BK" | tr '\n' ' '))"
cp -p $ST/config-store.ts $D/src/config-store.ts && cp -p $ST/device-session.ts $D/src/routes/device-session.ts && cp -p $ST/admin-data.ts $D/src/routes/admin-data.ts && cp -p $ST/release.json $D/release.json
if [ "$(m $D/src/config-store.ts)" != "4d95aef2c2db4adc29bb4cacb81b50ee" ] || [ "$(m $D/src/routes/device-session.ts)" != "3feaa45bb7508b333324dbc9e24834bd" ] || [ "$(m $D/src/routes/admin-data.ts)" != "43230d3caee6100c8d058cd07d416b7c" ] || [ "$(m $D/release.json)" != "913a31d6f7f4be59ca2f18d9b2a039ba" ]; then
  echo "ABORT post-copy md5 — restoring"; cp -p "$BK/device-session.ts" $D/src/routes/device-session.ts; cp -p "$BK/admin-data.ts" $D/src/routes/admin-data.ts; cp -p "$BK/config-store.ts" $D/src/config-store.ts; rm -f $D/release.json; exit 15
fi
echo "== T1 restart $(date -u +%Y-%m-%dT%H:%M:%SZ)"; cd $D && pm2 restart p003-voice >/dev/null; echo "pm2 restart rc=$?"
H=""; for i in $(seq 1 10); do sleep 2; H=$(curl -s -m 3 http://127.0.0.1:3001/health || true); [ "$H" = '{"status":"ok"}' ] && break; done; echo "health=$H (${i}x2s)"
pm2 jlist | python3 -c 'import json,sys; [print("pm2:",p["name"],"pid=",p["pid"],p["pm2_env"]["status"],"restarts=",p["pm2_env"]["restart_time"]) for p in json.load(sys.stdin) if p["name"]=="p003-voice"]'
[ "$H" = '{"status":"ok"}' ] || { echo "FAIL health — 回滚: cp -p $BK/device-session.ts $BK/admin-data.ts $D/src/routes/; cp -p $BK/config-store.ts $D/src/; rm $D/release.json; pm2 restart p003-voice"; exit 20; }
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3001/v1/device/session -H 'content-type: application/json' -d '{"device_sn":"x","trace_id":"b89-probe"}'); echo "no-cred device probe http=$code"; [ "$code" = "401" ] || { echo "FAIL probe"; exit 21; }
set -a; . $D/.env.local; set +a
TOK=$(curl -s -m 5 -X POST http://127.0.0.1:3001/api/auth/login -H 'content-type: application/json' -d "{\"username\":\"$STUDIO_USER\",\"password\":\"$STUDIO_PASS\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))')
[ -n "$TOK" ] || { echo "FAIL admin login"; exit 22; }
curl -s -m 5 http://127.0.0.1:3001/api/admin/oneshot -H "Authorization: Bearer $TOK" | python3 -c '
import json,sys; j=json.load(sys.stdin); p=j["policy"]
print("oneshot: ok=%s effective=%s source=%s override=%s env=%s agent=%s allow=%s release_ok=%s current=%s" % (j["ok"],p["effective"],p["source"],p["override"],p["env"],j["agent_name"],j["allowlist_count"],j["release"]["ok"],j["release"].get("data",{}).get("current",{}).get("label")))
assert j["ok"] and p["effective"]=="capability" and p["source"]=="env" and j["release"]["ok"], "smoke mismatch"'
echo "smoke rc=$?"; unset TOK STUDIO_PASS
E=/root/.pm2/logs/p003-voice-error.log; echo "err tail(POLICY/Error/import): $(tail -n 30 $E | grep -ciE 'POLICY|Error|import')"
echo "== DONE $(date -u +%Y-%m-%dT%H:%M:%SZ)"
