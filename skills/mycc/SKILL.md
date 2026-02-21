---
name: mycc
description: 启动 mycc 小程序后端服务（后台运行）。支持飞书频道双向通信。触发词："/mycc"、"启动 mycc"、"启动小程序后端"、"检查 mycc 状态"
---

# mycc

启动 mycc 小程序本地后端，连接网页版/小程序与本地 Claude Code。支持飞书消息收发。

## 环境要求

| 要求 | 说明 |
|------|------|
| Claude Code | **必须是官方原版**，fork 版本可能不兼容 |
| 网络 | **需要 VPN/代理**（cloudflared 需要访问外网） |
| 系统 | ✅ macOS、✅ Linux、✅ Windows (原生)、⚠️ WSL（不稳定） |

> 💡 **关于第三方 Claude Code**：目前仅测试了官方原版，第三方 fork 版本的兼容性支持在规划中。

## 依赖

- **Node.js 18+**：运行后端服务
- **cloudflared**：
  - macOS: `brew install cloudflare/cloudflare/cloudflared`
  - Linux: 参考 [官方文档](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  - Windows: `winget install Cloudflare.cloudflared` 或从官网下载
- **飞书 SDK**（可选，用于飞书频道）：`npm install @larksuiteoapi/node-sdk`

## 飞书频道配置（可选）

支持双向通信：接收飞书消息并回复。

### 配置步骤

1. 在 `.claude/skills/mycc/scripts/.env` 中配置：

```bash
# 飞书应用凭证
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx

# 接收消息的用户 ID
FEISHU_RECEIVE_USER_ID=ou_xxxxx
FEISHU_RECEIVE_ID_TYPE=open_id

# 连接模式：websocket（长连接）
FEISHU_CONNECTION_MODE=websocket

# 是否显示工具调用
FEISHU_SHOW_TOOL_USE=true
```

2. 获取飞书凭证：
   - 在[飞书开发者后台](https://open.feishu.com/)创建应用
   - 获取 `App ID` 和 `App Secret`
   - 添加应用到群聊或获取用户 Open ID

3. 长连接模式：
   - 在飞书开发者后台 → 事件与回调 → 订阅方式选择"使用长连接接收事件/回调"
   - 添加事件订阅：`im.message.receive_v1`

### 环境变量说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `FEISHU_APP_ID` | ✅ | 飞书应用 ID |
| `FEISHU_APP_SECRET` | ✅ | 飞书应用密钥 |
| `FEISHU_RECEIVE_USER_ID` | ✅ | 接收消息的用户/群组 ID |
| `FEISHU_RECEIVE_ID_TYPE` | - | `open_id`（用户）或 `chat_id`（群聊）|
| `FEISHU_CONNECTION_MODE` | - | `websocket` 或 `poll`，默认 poll |
| `FEISHU_SHOW_TOOL_USE` | - | 是否显示工具调用，默认 true |

### 飞书频道功能

- ✅ 接收消息：通过 WebSocket 长连接
- ✅ 发送消息：自动转发 Claude 回复到飞书
- ✅ 图片支持：上传/下载图片
- ✅ 工具调用显示：可配置是否显示工具调用详情
- ✅ "正在输入"表态：接收消息时显示

## 启动方式

### 方式 1：使用 `/mycc` 命令（推荐）

直接在 Claude Code 中输入：
- `/mycc`
- `启动 mycc`
- `启动小程序后端`

### 方式 2：使用启动脚本

| 系统 | 启动命令 | 停止命令 |
|------|----------|----------|
| Windows | `.\start-mycc.ps1` | `.\stop-mycc.ps1` |
| macOS/Linux | `./start-mycc.sh` | `./stop-mycc.sh` |

> ⚠️ **首次运行**：先安装依赖
> ```bash
> cd .claude/skills/mycc/scripts && npm install && cd -
> ```

## 触发词

- "/mycc"
- "启动 mycc"
- "启动小程序后端"
- "检查 mycc 状态"

## 执行步骤

### 1. 安装依赖（首次）

```bash
cd .claude/skills/mycc/scripts && npm install && cd -
```

### 2. 启动后端

```bash
.claude/skills/mycc/scripts/node_modules/.bin/tsx .claude/skills/mycc/scripts/src/index.ts start
```

使用 `run_in_background: true` 让后端在后台持续运行。

> 代码会自动检测项目根目录（向上查找 `.claude/` 或 `claude.md`），无需手动指定 cwd。

### 3. 读取连接信息

等待几秒后读取：
```bash
sleep 5 && cat .claude/skills/mycc/current.json
```

### 4. 告知用户

- 连接码（routeToken）
- 配对码（pairCode）
- 访问 https://mycc.dev 输入配对

## 关键说明

- **后台运行**：后端会在后台持续运行，不阻塞当前会话
- **自动检测 cwd**：会向上查找项目根目录，确保 hooks 能正确加载
- **连接信息**：保存在 `.claude/skills/mycc/current.json`
- **停止服务**：
  - Windows: `.\stop-mycc.ps1`
  - macOS/Linux: `./stop-mycc.sh`
  - 或手动：`lsof -i :18080 -t | xargs kill` (Unix) / `taskkill /PID <pid> /F` (Windows)

## 遇到问题？

**让 AI 自己解决。** 代码都在 `scripts/src/` 目录下，AI 可以：
1. 读取错误日志
2. 检查代码逻辑
3. 修复问题并重试

常见问题：
- **端口被占用**：`lsof -i :18080 -t | xargs kill`
- **cloudflared 未安装**：按上面的依赖说明安装
- **tunnel 启动失败**：检查网络，重试即可

---

## 连接信息格式

启动后保存在 `.claude/skills/mycc/current.json`：
```json
{
  "routeToken": "XXXXXX",
  "pairCode": "XXXXXX",
  "tunnelUrl": "https://xxx.trycloudflare.com",
  "mpUrl": "https://api.mycc.dev/XXXXXX",
  "cwd": "/path/to/project",
  "startedAt": "2026-01-27T06:00:00.000Z"
}
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/{token}/health` | GET | 健康检查 |
| `/{token}/pair` | POST | 配对验证 |
| `/{token}/chat` | POST | 发送消息 |
| `/{token}/history/list` | GET | 历史记录列表 |
| `/{token}/history/{sessionId}` | GET | 对话详情 |
