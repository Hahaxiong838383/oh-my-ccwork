# 部署指南

> 从零在 Ubuntu VPS 上部署 Gemini API Proxy。

## 前提

- Ubuntu 22.04+ VPS（1 核 1GB 内存即可）
- Python 3.10+
- 可直连 Google API（美国/日本等地区 VPS 通常可以）
- 一个 Google AI Studio API Key（[获取地址](https://aistudio.google.com/apikey)）

## 1. 连通性测试

```bash
# 先确认能访问 Google API
curl -s -o /dev/null -w "%{http_code}" https://generativelanguage.googleapis.com/v1beta/models
# 返回 403 = 网络通（只是缺 key），超时 = 需要代理
```

## 2. 安装依赖

```bash
apt-get update -qq
apt-get install -y python3-pip python3-venv

mkdir -p /opt/gemini-proxy
cd /opt/gemini-proxy
python3 -m venv venv
source venv/bin/activate
pip install aiohttp python-dotenv
```

## 3. 配置环境变量

```bash
cat > /opt/gemini-proxy/.env << 'EOF'
GEMINI_API_KEY=<你的 Google AI Studio API Key>
PROXY_TOKEN=<随机生成的访问 Token，建议 32+ 字符>
PROXY_PORT=4000
EOF

chmod 600 /opt/gemini-proxy/.env
```

生成随机 Token：

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

## 4. 部署代理脚本

将 `proxy.py` 上传到 `/opt/gemini-proxy/proxy.py`。

## 5. 配置 systemd 自启动

```bash
cat > /etc/systemd/system/gemini-proxy.service << 'EOF'
[Unit]
Description=Gemini API Proxy (OpenAI Compatible)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/gemini-proxy
ExecStart=/opt/gemini-proxy/venv/bin/python /opt/gemini-proxy/proxy.py
Restart=always
RestartSec=5
EnvironmentFile=/opt/gemini-proxy/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable gemini-proxy
systemctl start gemini-proxy
```

## 6. 验证

```bash
# Health check
curl http://localhost:4000/health

# 列出模型（需要 token）
curl http://localhost:4000/v1/models \
  -H "Authorization: Bearer <PROXY_TOKEN>"

# 对话测试
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer <PROXY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"hello"}],"max_tokens":100}'
```

## 常用运维命令

```bash
systemctl status gemini-proxy    # 状态
systemctl restart gemini-proxy   # 重启
journalctl -u gemini-proxy -f    # 实时日志
journalctl -u gemini-proxy --since "1 hour ago"  # 最近 1 小时日志
```

## 安全加固（可选）

```bash
# 1. 防火墙只开放 4000 端口
ufw allow 22/tcp
ufw allow 4000/tcp
ufw enable

# 2. 加 HTTPS（需要域名）
# apt install nginx certbot python3-certbot-nginx
# 配置 nginx 反向代理 + Let's Encrypt

# 3. 改 SSH 端口 + 禁用密码登录
```
