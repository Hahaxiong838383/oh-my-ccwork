#!/bin/bash
set -e
source /root/xray-nodes.env
PANEL="https://127.0.0.1:50971/ubahOu4nKzF38bFPA1"
JAR=/tmp/xui.jar
rm -f $JAR
curl -sk -c $JAR -X POST -d "username=HwLk3e1TQA&password=N0usDz8KPT" "$PANEL/login" >/dev/null

SNIFF='{"enabled":true,"destOverride":["http","tls","quic","fakedns"],"metadataOnly":false,"routeOnly":false}'
ALLOC='{"strategy":"always","refresh":5,"concurrency":3}'

# === VLESS + Reality :443 ===
VLESS_SETTINGS='{"clients":[{"id":"'$VLESS_UUID'","flow":"xtls-rprx-vision","email":"vless-reality","enable":true,"tgId":"","subId":"sub1","reset":0}],"decryption":"none","fallbacks":[]}'
VLESS_STREAM='{"network":"tcp","security":"reality","externalProxy":[],"realitySettings":{"show":false,"xver":0,"dest":"www.cloudflare.com:443","serverNames":["www.cloudflare.com"],"privateKey":"'$REALITY_PRIV'","minClient":"","maxClient":"","maxTimediff":0,"shortIds":["'$SHORT_ID'"],"settings":{"publicKey":"'$REALITY_PUB'","fingerprint":"chrome","serverName":"","spiderX":"/"}},"tcpSettings":{"acceptProxyProtocol":false,"header":{"type":"none"}}}'

echo "=== Add VLESS-Reality (POST /panel/api/inbounds/add) ==="
curl -sk -b $JAR -X POST "$PANEL/panel/api/inbounds/add" \
  -H "Content-Type: application/json" \
  -d @- << JSON
{
  "up":0,"down":0,"total":0,"remark":"US-VLESS-Reality","enable":true,"expiryTime":0,
  "listen":"","port":443,"protocol":"vless",
  "settings":$(echo "$VLESS_SETTINGS" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),
  "streamSettings":$(echo "$VLESS_STREAM" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),
  "sniffing":$(echo "$SNIFF" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),
  "allocate":$(echo "$ALLOC" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
}
JSON
echo ""

# === VMess + WS :10086 ===
VMESS_SETTINGS='{"clients":[{"id":"'$VMESS_UUID'","alterId":0,"email":"vmess-ws","security":"auto","enable":true,"tgId":"","subId":"sub1","reset":0}],"disableInsecureEncryption":false}'
VMESS_STREAM='{"network":"ws","security":"none","externalProxy":[],"wsSettings":{"acceptProxyProtocol":false,"path":"'$WS_PATH'","host":"","headers":{}}}'

echo "=== Add VMess-WS ==="
curl -sk -b $JAR -X POST "$PANEL/panel/api/inbounds/add" \
  -H "Content-Type: application/json" \
  -d @- << JSON
{
  "up":0,"down":0,"total":0,"remark":"US-VMess-WS","enable":true,"expiryTime":0,
  "listen":"","port":10086,"protocol":"vmess",
  "settings":$(echo "$VMESS_SETTINGS" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),
  "streamSettings":$(echo "$VMESS_STREAM" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),
  "sniffing":$(echo "$SNIFF" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),
  "allocate":$(echo "$ALLOC" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
}
JSON
echo ""

echo "=== Final list ==="
curl -sk -b $JAR "$PANEL/panel/api/inbounds/list" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('success'):
    for i in d['obj']:
        print(f'[id={i[\"id\"]}] {i[\"remark\"]} :{i[\"port\"]} {i[\"protocol\"]} enable={i[\"enable\"]}')
"

echo "=== Listen ==="
sleep 3
ss -tlnp | grep -E ":(443|10086)\b" || echo "(no match)"
