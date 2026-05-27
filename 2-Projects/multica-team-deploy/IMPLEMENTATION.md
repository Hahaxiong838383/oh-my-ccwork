# 实施方案 — 7 个 Phase

> 总工期估算：核心通路（Phase 0-5）约 1 个工作日；同事接入 + 稳定观察约 3-7 天。

## Phase 0 · 清理 Mini 资源（5 分钟）

**目标**：停 Ollama + mycc 后端，验证内存腾出 7-12 GB。

```bash
# 在 Air 上执行
ssh mini 'launchctl unload ~/Library/LaunchAgents/*ollama* 2>/dev/null; \
          brew services stop ollama 2>&1; \
          pkill -f "tsx.*mycc"; \
          pkill -f "node.*mycc"; \
          sleep 3; \
          vm_stat | awk "/Pages free/ {print \"free GB: \" \$3 * 4096 / 1024/1024/1024}"'
```

**验证**：`free GB` ≥ 10 → ✅；否则查谁还在占内存。

---

## Phase 1 · QNAP 拉镜像 + 写 compose（10 分钟）

**目标**：在 QNAP `/share/CACHEDEV2_DATA/multica/`（7.1TB 大盘）建工作目录并准备 compose。

```bash
ssh prnas '
  mkdir -p /share/CACHEDEV2_DATA/multica/{config,data}
  cd /share/CACHEDEV2_DATA/multica
  # docker 路径
  alias docker=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
  docker pull ghcr.io/multica-ai/multica-backend:v0.3.9
  docker pull ghcr.io/multica-ai/multica-web:v0.3.9
  docker pull pgvector/pgvector:pg17
  docker pull redis:7-alpine
'
```

**docker-compose.yml（落到 `/share/CACHEDEV2_DATA/multica/docker-compose.yml`）**：

```yaml
name: multica
services:
  postgres:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_DB: multica
      POSTGRES_USER: multica
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - ./data/pgdata:/var/lib/postgresql/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U multica"]
      interval: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - ./data/redis:/data

  backend:
    image: ghcr.io/multica-ai/multica-backend:v0.3.9
    depends_on:
      postgres: { condition: service_healthy }
    ports:
      - "<qnap-lan-ip>:8080:8080"   # 内网监听，公网走 FRP
    volumes:
      - ./data/uploads:/app/data/uploads
    environment:
      DATABASE_URL: postgres://multica:${POSTGRES_PASSWORD}@postgres:5432/multica?sslmode=disable
      PORT: "8080"
      JWT_SECRET: ${JWT_SECRET}
      FRONTEND_ORIGIN: https://multica.cli4.hahaxiong.cc
      CORS_ALLOWED_ORIGINS: https://multica.cli4.hahaxiong.cc
      RESEND_API_KEY: ${RESEND_API_KEY:-}
      MULTICA_APP_URL: https://multica.cli4.hahaxiong.cc
      ALLOW_SIGNUP: "false"
      ALLOWED_EMAILS: ${ALLOWED_EMAILS}        # 川哥+9 同事邮箱
      APP_ENV: production
      MULTICA_TRUSTED_PROXIES: "127.0.0.1/32,<qnap-lan-cidr>,<mini-lan-cidr>"
      MULTICA_PUBLIC_URL: https://multica.cli4.hahaxiong.cc
    restart: unless-stopped

  frontend:
    image: ghcr.io/multica-ai/multica-web:v0.3.9
    depends_on: [backend]
    ports:
      - "<qnap-lan-ip>:3080:3000"   # ★ 不用 3000 (被占)
    environment:
      HOSTNAME: "0.0.0.0"
    restart: unless-stopped
```

**.env 文件**（同目录，chmod 600）：

```bash
POSTGRES_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)
ALLOWED_EMAILS=<your-email>,colleague1@...,colleague2@...
RESEND_API_KEY=re_xxxxx  # 可选，先空跑用 backend log 抓验证码
```

---

## Phase 2 · 起 multica server stack（5 分钟）

```bash
ssh prnas 'cd /share/CACHEDEV2_DATA/multica && \
           /share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker compose up -d'

# 等 migration
sleep 30

# 验证
ssh prnas 'curl -s http://<qnap-lan-ip>:8080/healthz'
# 期望：{"status":"ok","checks":{"db":"ok","migrations":"ok"}}
```

**验证清单**：
- [ ] `docker ps` 看到 4 个 multica_* 容器都 `Up`
- [ ] `:8080/healthz` 返 200
- [ ] `:3080` 在浏览器能打开 login 页（Air 上 curl 看 HTML）

---

## Phase 3 · Caddy + TLS（在 HK relay 上做，10 分钟）

**前提**：cli4.hahaxiong.cc 的 DNS 加一条 CNAME（或 A 记录）：
- `multica.cli4.hahaxiong.cc` → 阿里云 HK relay 同一 IP

**HK relay 上 Caddyfile**：

```caddyfile
multica.cli4.hahaxiong.cc {
    # 自动 Let's Encrypt
    encode gzip

    # 所有路径反代到 FRP 后端
    reverse_proxy /api/* 127.0.0.1:18080
    reverse_proxy /ws*   127.0.0.1:18080 {
        # WebSocket Upgrade
        header_up Host {host}
        header_up X-Real-IP {remote_host}
    }
    reverse_proxy * 127.0.0.1:13080  # frontend
}
```

注：`18080` / `13080` 是 HK relay 上 FRP server 暴露的本地端口（对应 Mini frpc 转发的 QNAP:8080 / QNAP:3080）。

---

## Phase 4 · Mini frpc 加转发规则（5 分钟）

**Mini 上 frpc.toml 追加**：

```toml
[[proxies]]
name = "multica-api"
type = "tcp"
localIP = "<qnap-lan-ip>"
localPort = 8080
remotePort = 18080

[[proxies]]
name = "multica-web"
type = "tcp"
localIP = "<qnap-lan-ip>"
localPort = 3080
remotePort = 13080
```

```bash
ssh mini 'launchctl kickstart -k user/$(id -u)/frpc'   # 或对应的 reload 方式
```

**验证**：在 Air 上：
```bash
curl https://multica.cli4.hahaxiong.cc/healthz
# 期望返 200 + JSON
```

---

## Phase 5 · Mini 上跑 1 个 daemon 容器试通（15 分钟）

**daemon 容器 Dockerfile（先用 multica 官方 CLI 镜像，或自己装 Linux 基础镜像 + multica CLI + AI CLI）**：

```dockerfile
# ~/multica-daemons/Dockerfile.daemon
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y curl ca-certificates git \
    && curl -fsSL https://raw.githubusercontent.com/multica-ai/multica/main/scripts/install.sh | bash \
    && curl -fsSL https://claude.ai/install.sh | bash \
    && rm -rf /var/lib/apt/lists/*

# 注：实际 claude/codex/gemini CLI 装法待 Phase 7 时按官方文档落地
RUN useradd -m -s /bin/bash multica
USER multica
WORKDIR /home/multica
CMD ["multica", "daemon", "start", "--foreground"]
```

**单 daemon docker-compose（Mini 端）**：

```yaml
# ~/multica-daemons/alice/docker-compose.yml
services:
  daemon-alice:
    build:
      context: ..
      dockerfile: Dockerfile.daemon
    container_name: multica-daemon-alice
    volumes:
      - ./data:/home/multica/multica_workspaces
      - ./creds:/home/multica/.multica
      # 后续挂载 mycc 知识库只读：- ~/mycc/0-System:/mnt/mycc/0-System:ro
    environment:
      MULTICA_SERVER_URL: https://multica.cli4.hahaxiong.cc
      MULTICA_TOKEN: ${MULTICA_TOKEN_ALICE}
    restart: unless-stopped
```

**Phase 5 步骤**：
1. 川哥在 web UI 创建 workspace + 邀请 alice
2. alice 在 web UI Settings → Generate Personal Access Token → 复制到 `MULTICA_TOKEN_ALICE`
3. `docker compose up -d daemon-alice` 在 Mini 跑起来
4. 回 web UI Settings → Runtimes 看到 alice 的 daemon 出现 ✅

---

## Phase 6 · 同事 Mac 客户端安装脚本（写在 install-multica.sh）

```bash
#!/usr/bin/env bash
# install-multica.sh — 一键给同事装 Multica.app
set -euo pipefail

VERSION="0.3.9"
SERVER="https://multica.cli4.hahaxiong.cc"

# 1. 架构检查
ARCH=$(uname -m)
if [[ "$ARCH" != "arm64" ]]; then
    echo "❌ 检测到 Intel Mac（$ARCH）。"
    echo "Multica Desktop 当前仅支持 Apple Silicon。"
    echo "请用 Chrome/Safari 访问 $SERVER"
    exit 1
fi

# 2. 下载 .dmg
DMG="/tmp/multica-desktop-${VERSION}.dmg"
echo "📥 下载 Multica Desktop v${VERSION}..."
curl -fL -o "$DMG" \
    "https://github.com/multica-ai/multica/releases/download/v${VERSION}/multica-desktop-${VERSION}-mac-arm64.dmg"

# 3. 挂载 + 拷贝 .app
echo "📦 安装到 /Applications/..."
MOUNT=$(hdiutil attach "$DMG" -nobrowse | grep "Volumes" | awk '{print $3}')
cp -R "$MOUNT/Multica.app" /Applications/
hdiutil detach "$MOUNT" -quiet
rm "$DMG"

# 4. 写自托管配置
mkdir -p "$HOME/.multica"
cat > "$HOME/.multica/desktop.json" <<EOF
{
  "schemaVersion": 1,
  "apiUrl": "$SERVER",
  "wsUrl": "${SERVER/https/wss}/ws",
  "appUrl": "$SERVER"
}
EOF

# 5. 完成
echo ""
echo "✅ 装好了。在 Launchpad 找 Multica，点开就行。"
echo "   首次启动会要求邮箱验证（验证码会发到你邮箱）。"
echo "   有问题问川哥。"
```

**分发方式**：
- 把 `install-multica.sh` 放 GitHub Gist（私有）+ 给同事一行：`curl -fsSL https://...gist... | bash`
- 或者塞进 cli4.hahaxiong.cc 的某个静态目录

---

## Phase 7 · AI 订阅接入 + 扩 daemon + 团队上线

**Phase 7.1 · AI 凭据**（川哥后定，参考 DECISIONS.md "AI 订阅决策"）

**Phase 7.2 · 扩 3-5 个 daemon**
```bash
cd ~/multica-daemons
for user in bob carol dave eve; do
    cp -r alice $user
    # 改 docker-compose.yml 里的 container_name 和 MULTICA_TOKEN_*
done
docker compose -f docker-compose.all.yml up -d
```

**Phase 7.3 · mycc 集成**
- 在 QNAP 上跑 mycc brain（独立容器或装在 host）
- daemon 容器挂载 mycc 知识库只读
- multica skill 注入 brain MCP 调用

**Phase 7.4 · 团队邀请**
- web UI 邀请 9 个同事
- 每人收邀请邮件 → 装 Multica.app → 跑 install-multica.sh
- 川哥拉一个微信群做 onboarding

---

## 回滚 / 关停命令

```bash
# 关 multica（不删数据）
ssh prnas 'cd /share/CACHEDEV2_DATA/multica && docker compose down'

# 完全卸载（删数据 + 镜像）
ssh prnas 'cd /share/CACHEDEV2_DATA/multica && docker compose down -v && \
           docker rmi $(docker images "ghcr.io/multica-ai/*" -q) && \
           rm -rf /share/CACHEDEV2_DATA/multica'

# Mini daemon 关停
ssh mini 'cd ~/multica-daemons && docker compose down'

# 恢复 Mini 原服务
ssh mini 'brew services start ollama; cd ~/mycc/mycc-web && npm start &'
```
