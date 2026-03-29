# VPS Gemini API Proxy

> 在美国 IDC 服务器上部署轻量级 Gemini API 代理，提供 OpenAI 兼容接口，供 Agent 直接调用。

## 架构

```
Agent（本地/飞书/任意客户端）
       ↓ HTTP (OpenAI 格式)
美国 VPS（gemini-proxy，端口 4000）
       ↓ 转发 + 注入 API Key
Google Gemini API（直连，无需 WARP）
```

## 服务信息

| 项目 | 值 |
|------|-----|
| 服务地址 | `http://<VPS_IP>:4000` |
| API 格式 | OpenAI 兼容（`/v1/chat/completions`） |
| 鉴权方式 | Bearer Token |
| 内存占用 | ~22MB |
| 自启动 | systemd（`gemini-proxy.service`） |
| 可用模型 | 49 个（含 Gemini 3.1/3/2.5 全系列） |

## Agent 接入

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
print(resp.choices[0].message.content)
```

环境变量格式：

```bash
OPENAI_BASE_URL=http://<VPS_IP>:4000/v1
OPENAI_API_KEY=<PROXY_TOKEN>
OPENAI_MODEL=gemini-2.5-flash
```

## 推荐模型

| 场景 | 模型 | 输入 $/1M | 输出 $/1M |
|------|------|-----------|-----------|
| **日常默认** | `gemini-2.5-flash` | $0.30 | $2.50 |
| 极致省钱 | `gemini-2.5-flash-lite` | $0.10 | $0.40 |
| 快速响应 | `gemini-2.0-flash` | $0.10 | $0.40 |
| 复杂推理 | `gemini-2.5-pro` | $1.25 | $10.00 |
| 最新旗舰 | `gemini-3.1-pro-preview` | $2.00 | $12.00 |

> 完整模型列表和价格见 [models.md](./models.md)

## 服务器管理

```bash
systemctl status gemini-proxy    # 查看状态
systemctl restart gemini-proxy   # 重启
journalctl -u gemini-proxy -f    # 实时日志
cat /opt/gemini-proxy/.env       # 查看配置（含密钥）
```

## 部署详情

- 服务器环境：Ubuntu 24.04 LTS, 1 核, 2GB RAM
- 技术栈：Python 3.12 + aiohttp（虚拟环境 `/opt/gemini-proxy/venv/`）
- 代理脚本：`/opt/gemini-proxy/proxy.py`
- 环境配置：`/opt/gemini-proxy/.env`
- systemd 配置：`/etc/systemd/system/gemini-proxy.service`

如需重新部署，参考 [deploy.md](./deploy.md)。
