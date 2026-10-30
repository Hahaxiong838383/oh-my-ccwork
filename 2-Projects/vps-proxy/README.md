# VPS API Proxy Hub

> 当前运维入口（2026-10-29）：[RackNerd迁移与双栈复盘](2026-10-29-RackNerd迁移与双栈复盘.md)。新节点已在家庭网络由交付URI重建客户端验证，手机蜂窝待验；电视仍使用ZGO原选路，Cloudflare维护搁置。下文是早期API服务部署记录；4000/4001等服务在2026-07-25盘点已不存在，不能作为当前运行清单。

> 美国 VPS 上的多模型 API 代理服务，支持 Gemini + GPT-5.4（Codex），OpenAI 兼容接口，供 Agent 直接调用。

## 架构

```
Agent（本地/飞书/任意客户端）
       ↓ HTTP (OpenAI 格式)
美国 VPS（洛杉矶）
  ├── :4000  gemini-proxy  → Google Gemini API（API Key 计费）
  └── :4001  codex-proxy   → Codex CLI exec → OpenAI（ChatGPT Pro 订阅，免 API 费）
       └── :4002  codex app-server（常驻 WebSocket，保持 CLI 在线）
```

## 服务一览

| 服务 | 端口 | 模型 | 鉴权 | 流式 | 计费 |
|------|------|------|------|------|------|
| Gemini Proxy | 4000 | Gemini 全系列（49 个） | Bearer Token | ✅ | API Key 按量 |
| Codex Proxy | 4001 | gpt-5.4 | 无需（已 OAuth） | ✅ SSE | ChatGPT Pro 订阅 |

## Agent 接入

### Gemini（API Key 计费）

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://<VPS_IP>:4000/v1",
    api_key="<PROXY_TOKEN>",
)
resp = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "你好"}],
)
```

### GPT-5.4（ChatGPT Pro 订阅，免费）

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://<VPS_IP>:4001/v1",
    api_key="not-needed",  # 不需要 API Key
)
resp = client.chat.completions.create(
    model="gpt-5.4",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,  # 支持流式
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

### 环境变量格式

```bash
# Gemini
GEMINI_BASE_URL=http://<VPS_IP>:4000/v1
GEMINI_API_KEY=<PROXY_TOKEN>
GEMINI_MODEL=gemini-2.5-flash

# GPT-5.4
GPT_BASE_URL=http://<VPS_IP>:4001/v1
GPT_API_KEY=not-needed
GPT_MODEL=gpt-5.4
```

## 推荐模型

### Gemini 系列

| 场景 | 模型 | 输入 $/1M | 输出 $/1M |
|------|------|-----------|-----------|
| **日常默认** | `gemini-2.5-flash` | $0.30 | $2.50 |
| 极致省钱 | `gemini-2.5-flash-lite` | $0.10 | $0.40 |
| 快速响应 | `gemini-2.0-flash` | $0.10 | $0.40 |
| 复杂推理 | `gemini-2.5-pro` | $1.25 | $10.00 |
| 最新旗舰 | `gemini-3.1-pro-preview` | $2.00 | $12.00 |

> 完整模型列表和价格见 [models.md](./models.md)

### GPT 系列（ChatGPT Pro 订阅）

| 模型 | 延迟 | 说明 |
|------|------|------|
| `gpt-5.4` | ~3-6s | 唯一可用模型（ChatGPT Pro 限制） |

## Codex Proxy 配置

VPS 上的 `~/.codex/config.toml`：

```toml
model = "gpt-5.4"
service_tier = "fast"      # 快速推理模式

[reasoning]
effort = "low"             # 低推理深度 → 更快响应
summary = "none"           # 不生成推理摘要
```

### Service Tier 选项

| tier | 说明 |
|------|------|
| `fast` | 快速推理，低延迟优先 |
| `flex` | 弹性模式，可能更慢但更省额度 |
| 不设置 | 默认标准模式 |

### Token 管理

- 认证方式：Codex CLI OAuth（`codex login --device-auth`）
- Token 文件：`~/.codex/auth.json`（含 refresh_token，自动刷新）
- 订阅到期后需重新登录

## 服务器管理

```bash
# Gemini Proxy
systemctl status gemini-proxy
systemctl restart gemini-proxy
journalctl -u gemini-proxy -f

# Codex Proxy（API Wrapper）
systemctl status codex-proxy
systemctl restart codex-proxy
journalctl -u codex-proxy -f

# Codex App Server（常驻 WebSocket）
systemctl status codex-server
systemctl restart codex-server

# Health 检查
curl http://localhost:4001/health
curl http://localhost:4000/health
```

## 部署详情

- 服务器环境：Ubuntu 24.04 LTS, 1 核, 2GB RAM, 洛杉矶
- Gemini Proxy：Python 3.12 + aiohttp（`/opt/gemini-proxy/`）
- Codex Proxy：Python 3.12 零依赖（`/opt/codex-api-wrapper.py`）
- Codex CLI：Node.js 22 + @openai/codex v0.117.0
- systemd 服务：`gemini-proxy`、`codex-proxy`、`codex-server`

如需重新部署，参考 [deploy.md](./deploy.md)。

## 注意事项

- VPS IP 和凭证信息存放在本地 `.secrets/vps-racknerd.env`（已 gitignore）
- Codex CLI 的 `auth.json` 含敏感 token，仅存在 VPS 上
- SSH 连接不稳定时加 `-o ProxyCommand=none` 绕过本地代理

## 智慧生活电视控制调查

2026-10-30：[分析、证据与后续配合步骤](smartlife-tv/README.md)。静态初查已完成，待用户解锁手机确认实际电视插件；未发送电视开关机命令。
