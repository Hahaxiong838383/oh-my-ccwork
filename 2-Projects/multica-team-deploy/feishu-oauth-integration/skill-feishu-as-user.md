---
name: 飞书代理操作-zh
description: 以当前 issue 创建者 (multica user) 的飞书身份执行 lark-cli 操作 — 发消息/查日历/读文档/管理 wiki 等。每次操作前必须确认 user OAuth token 仍 valid,失效则拒绝执行并提示用户重新授权。
language: zh-CN
---

# 飞书代理操作员

## 何时使用

当 issue 描述里出现以下任一意图时,**必须**用这个 skill,**禁止**自己造 lark-cli 命令:

- 发飞书消息（im send / im chat-create / reply / forward）
- 读/写飞书日历（calendar event create/read/update）
- 操作飞书文档（docs / docx / wiki）
- 任何飞书操作（任何 `lark-cli <module>` 命令）

## 操作流程（必须严格按顺序）

### 步骤 1: 拿到当前 issue 的 feishu_user_id

```bash
# 从环境变量或 .agent_context/issue_context.md 拿 ISSUE_ID
multica issue get $ISSUE_ID --output json | jq -r '.metadata.feishu_user_id // empty'
```

如果输出为空 → **立即停止**,返回 issue comment:
"❌ 此 issue 缺少 metadata.feishu_user_id,无法代理飞书操作。请前往 multica web 设置 → 飞书授权 完成扫码绑定后,workspace 会自动给你创建的 issue 注入此字段。"

### 步骤 2: 检查该 user 的 token 是否 valid

```bash
FEISHU_USER_ID="<step1 输出>"
curl -sS "http://localhost:18090/api/feishu/device/status?multica_user_id=$FEISHU_USER_ID"
```

如果返回 `bound: false` 或 `token_status != "valid"` → **立即停止**,返回 issue comment:
"❌ multica user `$FEISHU_USER_ID` 的飞书授权已过期 / 未授权 (token_status: $status)。请重新扫码授权: 调 sidecar POST /api/feishu/device/start 重启 Device Flow。"

### 步骤 3: 用 05_agent_spawn.sh 透传 lark-cli 命令

```bash
bash ~/lark_multi_user/05_agent_spawn.sh $FEISHU_USER_ID <lark-cli 真实命令>
```

例子（发飞书消息给指定用户）:
```bash
bash ~/lark_multi_user/05_agent_spawn.sh $FEISHU_USER_ID \
  im +messages-send --user-id ou_xxxxxxxxxxxxxx --text "你的消息内容"
```

## 输出规范

成功时在 issue comment 回:
```
✅ 飞书操作完成
- 执行人 (multica user): $FEISHU_USER_ID
- 飞书身份: <step2 status 输出里的 lark_user_name>
- 操作: <命令简述>
- 结果: <message_id 或其他证据>
```

失败时必须含错误根因 + 修复建议。**禁止**伪造成功(虚假 message_id 等)。

## 铁律

1. **绝不**自己造 lark-cli 命令绕过 wrapper(`05_agent_spawn.sh`) — wrapper 保证 HOME 隔离 + 多用户安全
2. **绝不**用 multica workspace owner 的飞书身份执行(那是其他人的隐私)
3. **绝不**在 token 失效时硬跑 — 必须先重新授权
4. **必须**每次操作前重新查 status(token 可能在长任务执行期间失效)
5. **必须**输出真实 message_id / 操作结果作为证据,不允许虚假完成

## 常见 lark-cli 命令速查

| 操作 | 命令 |
|------|------|
| 发消息给用户 | `im +messages-send --user-id ou_xxx --text "..."` |
| 发消息到群 | `im +messages-send --chat-id oc_xxx --text "..."` |
| 创建日历事件 | `calendar +event-create --summary "..." --start-time "2026-..." --end-time "..."` |
| 读 wiki 节点 | `wiki +node-content-get --node-token wiki_xxx` |
| 搜员工 | `contact +user-search --query "张三"` |

详细参数: `bash ~/lark_multi_user/05_agent_spawn.sh $FEISHU_USER_ID <module> +<cmd> --help`
