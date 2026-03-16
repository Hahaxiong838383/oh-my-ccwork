# 飞书 API 高频陷阱速查

> 从实战中提炼的高频踩坑点。在使用飞书 API 或 MCP 工具前先查此文件。
> **优先级**：★★★ = 必看，★★ = 强烈建议，★ = 偶尔参考

---

## 文档写入（Docx）

### ★★★ 写块的唯一可靠方式
```
POST /open-apis/docx/v1/documents/{doc_id}/blocks/{doc_id}/children
body: {"children": [...]}   ← 绝对不加 index 字段
```
- 加了 `index` 字段 → 触发 9499 错误
- 并发写多个文档 → 触发 9499 错误
- 必须**逐篇顺序执行**，禁止并发

### ★★★ Block type 23（文件/媒体块）规则
- 创建时用空 token：`"file": {"token": ""}`，获得容器块 ID + 子块 ID
- 上传媒体必须用 `medias/upload_*`，不能用 `files/upload_*`
- 上传完成后 PATCH block：`{"replace_file": {"token": "media_token"}}`
- 视频内容在 `file` 字段，不在 `video` 字段（按 block_type 硬编码会漏掉）

### ★★★ 大文件上传（>20MB）
- 必须用分片上传：`medias/upload_prepare` → `medias/upload_part` × N → `medias/upload_finish`
- `files/upload_prepare` 只支持 parent_type=explorer（Drive），**不支持 docx_file**
- `files/upload_finish` 返回的 token 和 `medias/upload_finish` 返回的 token **不可互用**（强行用报 1770013 "relation mismatch"）
- 分片上传的全程必须用**同一身份 token**，否则报 `upload user not match`

### heading blocks 无法创建
- block_type 3+（heading）在创建时报 invalid param，不可用
- Wiki 节点创建必须带 `"node_type": "origin"`，否则报 400

---

## 消息发送

### ★★★ 签名算法（Webhook 签名）
```
key = timestamp + "\n" + secret   ← 注意：是 key，不是 message
message = ""                        ← message 是空字符串
HMAC-SHA256(key, message) → base64
```
- 错误码 19021 = sign match fail（签名验证失败）
- 有 secret 字段才加 `timestamp` + `sign`，无 secret 直接发裸 body

### ★★★ 消息类型
- 群聊 @mention 消息类型是 `post`（富文本），**不是** `text`
- post 结构：`{content: [[{tag:"text",text:"..."},{tag:"at",...}]]}`
- 去 @mention 占位符：`text.replace(/@_user_\d+/g, "").trim()`

### open_id vs chat_id
- `open_id` → P2P 单聊
- `chat_id` → 指定聊天（P2P 或群聊）
- 两者不可混用，传错类型会静默失败或发错窗口

### 错误码速查
| 错误码 | 含义 |
|--------|------|
| 19021 | 签名验证失败 |
| 99991668 | 机器人不在群中 |
| 230002 | bot 不在群（权限不足） |
| 11246 | update_multi is false（卡片 Schema 版本错误）|
| 9499 | 文档写入错误（index 字段 / 并发写）|
| 1770013 | relation mismatch（token 类型不匹配）|

---

## MCP 特定注意事项

### ★★★ `create_blocks` MCP 工具不可用
- `descendants` 参数接收 JSON 时被当字符串处理，无法正常工作
- 改用 `feishu_openapi_call` 直接调用 REST API

### 代理冲突
- `NO_PROXY` 必须在**任何飞书 API 调用之前**设置（包括 getAccessToken）
- 否则第一个通道会走代理失败

### Token 三层防护
- HealthMonitor 每 5 分钟检查 `~/.feishu-mcp/tokens.json`
- 过期前 30 分钟用 `refresh_token` 自动刷新
- 丢失时从 `~/.feishu-mcp/tokens.backup.json` 自动恢复
- 强制重授权：删除 `tokens.json` → 重走 OAuth 流程

---

## 飞书 API 技巧

### Download 接口
- `drive/v1/medias/{file_token}/download`：不支持 HEAD 请求（返回 404），GET 正常

### WebSocket 事件字段 vs REST API 字段
| 场景 | 消息类型字段 | 发送方字段 |
|------|------------|---------|
| WS 事件 | `message_type` | `event.sender` |
| REST API | `msg_type` | `msg.sender` |

### open_id 是应用级作用域
- 同一用户/bot 在不同 Feishu App 下的 open_id **不同**
- `GET /bot/v3/info` 返回的是**本 app 视角**的 bot open_id
