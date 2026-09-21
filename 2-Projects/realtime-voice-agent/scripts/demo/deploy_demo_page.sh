#!/bin/bash
# 部署语音体验 demo 页到 47.239：仓内模板 → 服务器现签 token 注入 → 备份旧页 → 上线。token 不经本机、不打印。
# 用法：scripts/demo/deploy_demo_page.sh   （可用 DEMO_HOST / DEMO_AGENT / DEMO_ROOM / DEMO_TTL_DAYS 覆盖）
set -eu
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
HOST=${DEMO_HOST:-root@47.239.204.68}
AGENT=${DEMO_AGENT:-rust-worker-demo}; ROOM=${DEMO_ROOM:-voice-test-rust}; TTL=${DEMO_TTL_DAYS:-180}
grep -q '__LIVEKIT_TOKEN__' "$ROOT/web/voice-test-rust.html"
scp -q "$ROOT/web/voice-test-rust.html" "$HERE/sign_demo_token.py" "$HOST:/tmp/"
ssh "$HOST" "set -eu
export T=\$(/root/voice-venv/bin/python /tmp/sign_demo_token.py --room '$ROOM' --agent '$AGENT' --ttl-days '$TTL')
python3 - <<'PY'
import os
p='/tmp/voice-test-rust.html'; s=open(p,encoding='utf-8').read()
assert s.count('__LIVEKIT_TOKEN__')==1
open(p,'w',encoding='utf-8').write(s.replace('__LIVEKIT_TOKEN__',os.environ['T']))
PY
[ -f /var/www/voice/voice-test-rust.html ] && cp -p /var/www/voice/voice-test-rust.html /root/voice-test-rust.html.bak-\$(date +%Y%m%d-%H%M%S)
install -m 644 /tmp/voice-test-rust.html /var/www/voice/voice-test-rust.html
rm -f /tmp/voice-test-rust.html /tmp/sign_demo_token.py
python3 - <<'PY'
import re,json,base64,datetime
s=open('/var/www/voice/voice-test-rust.html',encoding='utf-8').read()
t=re.search(r'const TOKEN = \"([^\"]+)\"',s).group(1); p=t.split('.')[1]; p+='='*(-len(p)%4); c=json.loads(base64.urlsafe_b64decode(p))
print('deployed: room=%s agent=%s exp=%s'%(c['video']['room'],c['roomConfig']['agents'][0]['agentName'],datetime.datetime.fromtimestamp(c['exp']).strftime('%Y-%m-%d')))
PY"
