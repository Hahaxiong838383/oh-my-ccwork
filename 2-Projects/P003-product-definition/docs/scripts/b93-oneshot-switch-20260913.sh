#!/usr/bin/env bash
# B93 联调窗口：切 One-shot 签发策略（后台 runtime override，秒生效）。token 只在进程内，绝不打印；操作人脱敏。
# 用法：bash b93-oneshot-switch.sh off|capability|allowlist|clear ["note"]
set -euo pipefail
POLICY="${1:?usage: $0 view|off|capability|allowlist|clear [note]}"
NOTE="${2:-B93 联调窗口 by cc}"
cd /opt/p003/server
set -a; . ./.env.local; set +a
BASE=http://127.0.0.1:3001
LOGIN_BODY=$(python3 -c 'import json,os;print(json.dumps({"username":os.environ["STUDIO_USER"],"password":os.environ["STUDIO_PASS"]}))')
T=$(curl -sS -X POST "$BASE/api/auth/login" -H 'content-type: application/json' --data-binary "$LOGIN_BODY" \
  | python3 -c 'import sys,json; j=json.load(sys.stdin); print(next(v for k,v in j.items() if "token" in k.lower() and isinstance(v,str)))')
[ -n "$T" ] || { echo LOGIN_FAIL; exit 1; }
view() {
  curl -sS -H "authorization: Bearer $T" "$BASE/api/admin/oneshot" | python3 -c '
import sys,json
j=json.load(sys.stdin); p=j["policy"]; o=p.get("override")
if o: o=dict(o); o["updated_by"]="<admin>"
r=(j.get("release") or {}).get("data") or {}; c=r.get("current") or {}
print(json.dumps({"effective":p["effective"],"source":p["source"],"env":p["env"],"override":o,"release":{"label":c.get("label"),"since":c.get("since"),"sealed_at":(c.get("sealed") or {}).get("at"),"apk":(c.get("apk") or "")[:60]}}, ensure_ascii=False))'
}
echo "before: $(view)"
if [ "$POLICY" = view ]; then exit 0; fi
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ "$POLICY" = clear ]; then
  curl -sS -X DELETE -H "authorization: Bearer $T" "$BASE/api/admin/oneshot/policy" \
    | python3 -c 'import sys,json; j=json.load(sys.stdin); print("delete:", json.dumps({"removed":j.get("removed"),"before":j.get("before"),"error":j.get("error")}))'
else
  BODY=$(python3 -c 'import json,sys;print(json.dumps({"policy":sys.argv[1],"note":sys.argv[2]}))' "$POLICY" "$NOTE")
  curl -sS -X PUT -H "authorization: Bearer $T" -H 'content-type: application/json' --data-binary "$BODY" "$BASE/api/admin/oneshot/policy" \
    | python3 -c 'import sys,json; j=json.load(sys.stdin); print("put:", json.dumps({"changed":j.get("changed"),"before":j.get("before"),"error":j.get("error")}, ensure_ascii=False))'
fi
echo "at: $TS"
echo "after:  $(view)"
echo "log: $(grep -h '\[admin-oneshot\]' "$HOME/.pm2/logs/p003-voice-out.log" | tail -n 1 | sed -E 's/by=[^ ]*/by=<admin>/')"
