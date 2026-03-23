#!/bin/bash
# cc-remote V4 — 新用户一键部署脚本
# 用法：./deploy-user.sh <用户名> <密码> [子域名前缀] [caddy端口]
#
# 示例：
#   ./deploy-user.sh bob 'MyPass123'              → cli-bob.hahaxiong.cc:29443
#   ./deploy-user.sh alice 'AlicePass' cli-alice 39443 → cli-alice.hahaxiong.cc:39443
#
# 执行两步：
#   1. 在阿里云 relay 上配置 nginx vhost + SSL + htpasswd（通过云助手 API）
#   2. 生成用户部署包 cc-remote-v4-<用户名>/（发给用户在自己机器上运行）

set -e

USERNAME="${1:?用法: $0 <用户名> <密码> [子域名前缀] [caddy端口]}"
PASSWORD="${2:?缺少密码参数}"
SUBDOMAIN="${3:-cli-${USERNAME}}"
CADDY_PORT="${4:-$(( 19443 + $(echo "$USERNAME" | cksum | cut -d' ' -f1) % 10000 + 10000 ))}"
DOMAIN="${SUBDOMAIN}.hahaxiong.cc"
RELAY_IP="8.218.26.17"
FRP_TOKEN="ccremote-v4-2026"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== cc-remote V4 新用户部署 ==="
echo "  用户名:    $USERNAME"
echo "  域名:      $DOMAIN"
echo "  Caddy端口: $CADDY_PORT"
echo "  Relay:     $RELAY_IP"
echo ""

# ============ Step 1: 阿里云 relay 配置 ============
echo "[Step 1] 配置阿里云 relay..."

# 1a. 添加 DNS A 记录
echo "  添加 DNS: $DOMAIN → $RELAY_IP"
python3 << PYEOF
import hmac, hashlib, base64, urllib.parse, urllib.request, json, uuid, time

AK_ID = "${ALIBABA_AK_ID:-LTAI5tSDb***6Aus}"
AK_SECRET = "${ALIBABA_AK_SECRET:-WkfsofFxSu9Awu9YVnwHYmgfNViBTr}"

def sign_request(params, secret):
    sorted_qs = urllib.parse.urlencode(sorted(params.items()), quote_via=urllib.parse.quote)
    string_to_sign = "GET&%2F&" + urllib.parse.quote(sorted_qs, safe="")
    h = hmac.new((secret + "&").encode(), string_to_sign.encode(), hashlib.sha1)
    return base64.b64encode(h.digest()).decode()

def call_dns_api(action, extra_params):
    params = {
        "Format": "JSON", "Version": "2015-01-09", "AccessKeyId": AK_ID,
        "SignatureMethod": "HMAC-SHA1", "Timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "SignatureVersion": "1.0", "SignatureNonce": str(uuid.uuid4()), "Action": action,
    }
    params.update(extra_params)
    params["Signature"] = sign_request(params, AK_SECRET)
    url = f"https://alidns.aliyuncs.com/?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=15) as resp:
            r = json.loads(resp.read())
            print(f"  DNS: {'OK' if 'RecordId' in r else r.get('Message', 'unknown')}")
    except Exception as e:
        print(f"  DNS: {e}")

call_dns_api("AddDomainRecord", {"DomainName": "hahaxiong.cc", "RR": "$SUBDOMAIN", "Type": "A", "Value": "$RELAY_IP", "TTL": "600"})
PYEOF

# 1b. 在 relay 上配置 nginx + SSL（通过云助手）
echo "  配置 nginx + SSL..."
python3 << PYEOF
import hmac, hashlib, base64, urllib.parse, urllib.request, json, uuid, time

AK_ID = "${ALIBABA_AK_ID:-LTAI5tSDb***6Aus}"
AK_SECRET = "${ALIBABA_AK_SECRET:-WkfsofFxSu9Awu9YVnwHYmgfNViBTr}"

def sign_request(params, secret):
    sorted_qs = urllib.parse.urlencode(sorted(params.items()), quote_via=urllib.parse.quote)
    string_to_sign = "GET&%2F&" + urllib.parse.quote(sorted_qs, safe="")
    h = hmac.new((secret + "&").encode(), string_to_sign.encode(), hashlib.sha1)
    return base64.b64encode(h.digest()).decode()

def call_ecs_api(action, extra_params):
    params = {
        "Format": "JSON", "Version": "2014-05-26", "AccessKeyId": AK_ID,
        "SignatureMethod": "HMAC-SHA1", "Timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "SignatureVersion": "1.0", "SignatureNonce": str(uuid.uuid4()), "Action": action,
    }
    params.update(extra_params)
    params["Signature"] = sign_request(params, AK_SECRET)
    url = f"https://ecs.cn-hongkong.aliyuncs.com/?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url), timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": e.read().decode()[:500]}

SETUP = r"""#!/bin/bash
set -e
htpasswd -cb /etc/nginx/.htpasswd-$USERNAME '$PASSWORD'

cat > /etc/nginx/sites-available/cc-remote-$USERNAME << 'NGXEOF'
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
server {
    listen 443 ssl;
    server_name $DOMAIN;
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    auth_basic "cc-remote";
    auth_basic_user_file /etc/nginx/.htpasswd-$USERNAME;
    proxy_buffering off;
    location / {
        proxy_pass http://127.0.0.1:$CADDY_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
NGXEOF

ln -sf /etc/nginx/sites-available/cc-remote-$USERNAME /etc/nginx/sites-enabled/
# 先用 HTTP 模式申请证书
sed -i '/ssl_certificate/d' /etc/nginx/sites-available/cc-remote-$USERNAME
sed -i 's/listen 443 ssl/listen 443/' /etc/nginx/sites-available/cc-remote-$USERNAME
nginx -t && systemctl reload nginx
sleep 5
certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email admin@hahaxiong.cc --redirect 2>&1 || true
nginx -t && systemctl reload nginx

# 开放端口
ufw allow $CADDY_PORT/tcp 2>/dev/null || true

echo "DONE: $DOMAIN → :$CADDY_PORT"
"""

result = call_ecs_api("RunCommand", {
    "RegionId": "cn-hongkong", "Type": "RunShellScript",
    "CommandContent": base64.b64encode(SETUP.encode()).decode(),
    "InstanceId.1": "i-j6cher4yitk4sw7m38yy", "Timeout": "120", "ContentEncoding": "Base64",
})
invoke_id = result.get("InvokeId", "")
print(f"  云助手任务: {invoke_id}")

# 等待完成
for i in range(8):
    time.sleep(15)
    r = call_ecs_api("DescribeInvocationResults", {"RegionId": "cn-hongkong", "InvokeId": invoke_id})
    items = r.get("Invocation", {}).get("InvocationResults", {}).get("InvocationResult", [])
    if items and items[0].get("InvocationStatus") in ("Success", "Failed"):
        status = items[0]["InvocationStatus"]
        output = base64.b64decode(items[0].get("Output", "")).decode(errors="replace")
        print(f"  状态: {status}")
        if "DONE" in output:
            print(f"  ✓ relay 配置完成")
        else:
            print(f"  输出: {output[-200:]}")
        break
    print(f"  等待... ({i+1})")
PYEOF

# ============ Step 2: 生成用户部署包 ============
echo ""
echo "[Step 2] 生成部署包..."

OUTDIR="$DIR/cc-remote-v4-${USERNAME}"
mkdir -p "$OUTDIR/panel"

# 复制核心文件
cp "$DIR/panel/index.html" "$OUTDIR/panel/"
cp "$DIR/ttyd-wrapper.sh" "$OUTDIR/"
cp "$DIR/tmux-session.sh" "$OUTDIR/"
cp "$DIR/api.py" "$OUTDIR/"
cp "$DIR/watchdog.sh" "$OUTDIR/"
chmod +x "$OUTDIR/ttyd-wrapper.sh" "$OUTDIR/tmux-session.sh" "$OUTDIR/watchdog.sh"

# 生成用户专属 frpc.toml
cat > "$OUTDIR/frpc.toml" << EOF
serverAddr = "$RELAY_IP"
serverPort = 7000
auth.token = "$FRP_TOKEN"

[[proxies]]
name = "cc-remote-${USERNAME}"
type = "tcp"
localIP = "127.0.0.1"
localPort = $CADDY_PORT
remotePort = $CADDY_PORT
EOF

# 生成用户专属 Caddyfile
cat > "$OUTDIR/Caddyfile" << EOF
:${CADDY_PORT} {
	handle / {
		root * $(pwd)/cc-remote-v4-${USERNAME}/panel
		file_server
	}
	handle /panel/* {
		root * $(pwd)/cc-remote-v4-${USERNAME}/panel
		file_server
	}
	handle /api/* {
		reverse_proxy localhost:$((CADDY_PORT + 100))
	}
	handle /claude/* {
		reverse_proxy localhost:$((CADDY_PORT + 1)) {
			transport http { read_timeout 0; write_timeout 0 }
		}
	}
	handle /codex/* {
		reverse_proxy localhost:$((CADDY_PORT + 2)) {
			transport http { read_timeout 0; write_timeout 0 }
		}
	}
	handle /gemini/* {
		reverse_proxy localhost:$((CADDY_PORT + 3)) {
			transport http { read_timeout 0; write_timeout 0 }
		}
	}
}
EOF

# 生成用户专属 start.sh
cat > "$OUTDIR/start.sh" << 'STARTEOF'
#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
PROJECT_DIR="${CC_REMOTE_CWD:-$HOME}"

echo "=== cc-remote V4 启动 ==="
pkill -f "ttyd -p ${CADDY_PORT}" 2>/dev/null || true
pkill -f "caddy run.*${USERNAME}" 2>/dev/null || true
sleep 1

ensure_tmux() {
  if tmux has-session -t "cc-$1" 2>/dev/null; then
    echo "  ♻ cc-$1 已存在"
  else
    tmux new-session -d -s "cc-$1" -c "$PROJECT_DIR" "$1"
    echo "  ✓ cc-$1 已创建"
  fi
}

command -v claude &>/dev/null && ensure_tmux claude
command -v codex &>/dev/null && ensure_tmux codex
command -v gemini &>/dev/null && ensure_tmux gemini

# 启动 ttyd 实例
PORT_BASE=$((CADDY_PORT + 1))
for cli in claude codex gemini; do
  session="cc-$cli"
  if tmux has-session -t "$session" 2>/dev/null; then
    "$DIR/ttyd-wrapper.sh" "$PORT_BASE" "/$cli" "$session" &
    echo "  ✓ $cli → :$PORT_BASE"
  fi
  PORT_BASE=$((PORT_BASE + 1))
done

# 启动 API
python3 "$DIR/api.py" &
echo "  ✓ API → :$((CADDY_PORT + 100))"

# 启动 Caddy
caddy run --config "$DIR/Caddyfile" --adapter caddyfile &
echo "  ✓ Caddy → :$CADDY_PORT"

echo "=== 就绪 ==="
STARTEOF
chmod +x "$OUTDIR/start.sh"

# 生成 README
cat > "$OUTDIR/README.md" << EOF
# cc-remote V4 — ${USERNAME} 部署包

## 访问地址
https://${DOMAIN}/
用户名: ${USERNAME}
密码: (部署时设置的密码)

## 安装步骤
\`\`\`bash
# 1. 安装依赖
brew install caddy ttyd tmux

# 2. 下载 frpc
# macOS ARM: https://github.com/fatedier/frp/releases (darwin_arm64)

# 3. 启动
./start.sh

# 4. 启动 frpc
frpc -c frpc.toml
\`\`\`

## 配置
- Caddy 端口: ${CADDY_PORT}
- FRP relay: ${RELAY_IP}:7000
- 域名: ${DOMAIN}
EOF

echo "  ✓ 部署包已生成: $OUTDIR/"
echo ""
echo "========================================="
echo "  部署完成！"
echo "  域名: https://${DOMAIN}/"
echo "  用户: ${USERNAME} / (设置的密码)"
echo "  部署包: $OUTDIR/"
echo "  将 $OUTDIR/ 发给用户，用户在自己机器上运行即可"
echo "========================================="
