---
name: 飞书代理操作-zh
description: 以当前 issue 创建者 (multica user) 的飞书身份执行 lark-cli 操作 — 发消息/查日历/读文档/管理 wiki 等。V4 fallback creator_id 当 metadata 空 (99% 场景免显式注入)。区分真实 OAuth 失效 vs lark-cli 临时错误，token 失效才停 + 拒绝;临时错误 max 2 次 retry。V3 加 metadata.private_to 隔离检查。永不伪造结果。
language: zh-CN
---

# 飞书代理操作员 (V4)

## 何时使用

issue 描述里出现以下任一意图时，**必须**用这个 skill，**禁止**自己造 lark-cli 命令：

- 发飞书消息（im send / chat-create / reply / forward）
- 读/写飞书日历（calendar event create/read/update）
- 操作飞书文档（docs / docx / wiki）
- 任何飞书操作（任何 `lark-cli <module>` 命令）

## 操作流程（必须严格按顺序）

### 步骤 0 (V3): 私密 issue 隔离检查 — 防身份误用

multica 当前 workspace 内所有 issue 互看 (没 per-issue ACL),但 `metadata.private_to` 是 issue 创建者标记的"只允许这个 multica user 名下的飞书身份执行"约定。**先拿 ISSUE 完整 JSON,一次解析三个字段(含 creator_id 给 V4 fallback 用)**:

```bash
ISSUE_JSON=$(multica issue get $ISSUE_ID --output json)
PRIVATE_TO=$(echo "$ISSUE_JSON" | jq -r '.metadata.private_to // empty')
FEISHU_USER_ID_META=$(echo "$ISSUE_JSON" | jq -r '.metadata.feishu_user_id // empty')
CREATOR_ID=$(echo "$ISSUE_JSON" | jq -r '.creator_id // empty')
CREATOR_TYPE=$(echo "$ISSUE_JSON" | jq -r '.creator_type // empty')
```

**判定铁律 — 私密 issue (违反 = 安全事故)**:

- `private_to` 为空 → 公开 issue, 跳过本步走步骤 1+ 的常规校验 (会自动走 V4 fallback)
- `private_to` 非空 → **必须**显式 `metadata.feishu_user_id`, 严格校验 `private_to == feishu_user_id`:
  - 自洽 → 放行,**禁止用 V4 fallback** (私密 issue 不允许猜身份)
  - `feishu_user_id` 为空 → 拒绝:
    > 🔒 此 issue 标了 `private_to=$PRIVATE_TO` (私密),但缺 `metadata.feishu_user_id`,**拒绝执行**。请 issue 创建者补 `metadata.feishu_user_id=$PRIVATE_TO` 后 rerun。私密 issue 不允许 fallback。
  - 不一致 → 拒绝:
    > 🔒 私密 issue: `metadata.private_to=$PRIVATE_TO`, 但 `metadata.feishu_user_id=$FEISHU_USER_ID_META` 不一致,**拒绝执行**。

**不允许的反模式 (私密 issue 场景)**:
- ❌ 把 `private_to` 解释成"软提示",硬跑
- ❌ 私密 issue 用 V4 fallback 推导 `creator_id` 当 `feishu_user_id` — 违反"必须显式"原则
- ❌ 用 owner 身份 / workspace 默认身份替代

### 步骤 1 (V4 升级): 决定 FEISHU_USER_ID — fallback 推导链

按以下**优先级顺序**决定 `FEISHU_USER_ID`:

```
1. metadata.feishu_user_id 非空 → 直接用 (尊重显式注入)
2. metadata.feishu_user_id 为空 + creator_type == "member" → 用 creator_id (V4 fallback)
3. 其他 → 报错 + 引导授权
```

**Bash 实现**:

```bash
if [ -n "$FEISHU_USER_ID_META" ]; then
  FEISHU_USER_ID="$FEISHU_USER_ID_META"
  FEISHU_SOURCE="metadata.feishu_user_id (显式)"
elif [ "$CREATOR_TYPE" = "member" ] && [ -n "$CREATOR_ID" ]; then
  FEISHU_USER_ID="$CREATOR_ID"
  FEISHU_SOURCE="issue.creator_id (V4 fallback,99% 场景适用)"
else
  FEISHU_USER_ID=""
fi
```

**V4 fallback 适用前提**:
- multica user 已通过 oauth-ui 扫码绑定过飞书 → sidecar mapping 有 `{multica_user_id == issue.creator_id} → lark_user_open_id`
- 步骤 2 调 sidecar `/status` 会自动验证 (返回 bound:false 时给清晰错误)
- 这避免了"每个 issue 必须显式 metadata 注入"的负担,99% 普通 issue 自然走通

**FEISHU_USER_ID 为空时的错误处理**:

> ❌ 无法确定 issue 对应的飞书身份:
> - `metadata.feishu_user_id` 为空 (未显式注入)
> - `creator_type=$CREATOR_TYPE` 不是 `member` (可能是 agent 创建的 issue)
>
> 请 issue 创建者补 `metadata.feishu_user_id=<你的 multica user id>`,或前往 https://multica.cli4.hahaxiong.cc/oauth-ui 完成飞书绑定后由本人重新派单。

### 步骤 2: 检查该 user 的 token 是否 valid

```bash
FEISHU_USER_ID="<step1 输出>"
STATUS_JSON=$(curl -sS "http://localhost:18090/api/feishu/device/status?multica_user_id=$FEISHU_USER_ID")
echo "$STATUS_JSON" | jq .
```

**仅当 sidecar 明确返回 `bound:false` 或 `token_status != "valid"`** → 立即停止，issue comment 回：
> ❌ multica user `$FEISHU_USER_ID` 的飞书授权已过期/未授权 (sidecar 返回 token_status: `<status>`)。请访问 https://multica.cli4.hahaxiong.cc/oauth-ui?multica_user_id=$FEISHU_USER_ID 重新扫码授权。

**注意**：以下情况**不算** token 失效，不要错误归因：
- sidecar `/status` 返回网络错误（curl timeout）→ 临时问题，retry sidecar 一次
- lark-cli 后续命令失败（步骤 3）→ 看错误码分类（见下），不要直接判定 token 失效

### 步骤 3: 用 05_agent_spawn.sh 透传 lark-cli 命令（含错误分类与重试）

```bash
RESPONSE=$(bash ~/lark_multi_user/05_agent_spawn.sh $FEISHU_USER_ID <lark-cli-args>)
EXIT_CODE=$?
echo "$RESPONSE"
```

**判定结果（严格按顺序，禁止跳级）**：

#### 3.1 成功路径
若 RESPONSE 是合法 JSON 且 `.ok == true` → 操作成功，按"输出规范"回 issue comment。

#### 3.2 OAuth 失效路径（仅这类才停掉走授权流程）
若 RESPONSE 含以下任一信号 → 真实 token 失效：
- `code: 99991671` / `99991673` / `99991668`（飞书 access_token 类错误码）
- HTTP 401 / 403 状态
- 显式提示 `invalid_token` / `token_expired` / `access_token_invalid`
- 含 `"error": "token_invalid"` 关键字（来自 wrapper）

→ 走步骤 2 的"已过期"分支提示 user 重新扫码。

#### 3.3 lark-cli 临时错误路径（必须 retry max 2 次）
若 RESPONSE 含以下信号 → 临时错误：
- HTTP 5xx / `internal server error` / `service unavailable`
- 网络类错误 `connection refused` / `timeout` / `EOF` / `read tcp`
- 飞书限流 `code: 99991400` / `frequency limit`
- lark-cli stderr 含 `proxy` 字样但 stdout 空（proxy 抖动）

→ `sleep 2 && retry` 重试 1 次，再失败 `sleep 5 && retry` 第 2 次。仍失败按"业务失败"返回。

#### 3.4 业务参数错误路径（不重试，立即报错）
若 RESPONSE 含以下信号 → 业务错误（参数不对/权限不够）：
- HTTP 400 + clear validation error
- 飞书 code `99991400` 含 `invalid params` 字样
- 权限不足 `permission denied` / `not authorized for this scope`

→ 不重试，按"输出规范"返回错误（含原始 error 给 user 看，便于修参数）。

#### 3.5 未知错误（保守归类为业务失败，不轻易触发授权流程）
任何 3.2-3.4 都不匹配的错误 → 报"未知错误"，**禁止**默认归类为 token 失效，**禁止**编造 sidecar 状态。

## 输出规范

### 成功
```
✅ 飞书操作完成
- 执行人 (multica user): $FEISHU_USER_ID
- 身份来源: $FEISHU_SOURCE  ← V4 标注 (metadata 显式 vs creator_id fallback)
- 飞书身份: <step2 status 输出的 lark_user_name>
- 操作: <命令简述>
- 结果: <message_id 或其他证据，从 RESPONSE.data 提取>
- 重试次数: <0/1/2>
```

### Token 失效
```
❌ 飞书授权已过期，需重新扫码
- multica user: $FEISHU_USER_ID
- 检测来源: <sidecar status / lark-cli OAuth code>
- 重新授权链接: https://multica.cli4.hahaxiong.cc/oauth-ui?multica_user_id=$FEISHU_USER_ID
```

### 临时错误（已 retry 仍失败）
```
⚠️ 飞书 API 临时不可用 (已重试 2 次)
- multica user: $FEISHU_USER_ID  
- 错误: <RESPONSE 原文摘要>
- 建议: 等待 5-10 分钟后 rerun 此 issue
```

### 业务错误
```
❌ 飞书操作业务失败
- multica user: $FEISHU_USER_ID
- 错误: <RESPONSE.error 原文>
- 修复方向: <根据错误码给的建议>
```

## 铁律（违反一律视为流程失败）

1. **绝不**自己造 lark-cli 命令绕过 wrapper(`05_agent_spawn.sh`)
2. **绝不**用 workspace owner 的飞书身份执行别人的 issue
3. **绝不**在 sidecar `/status` 明确返回 `bound:false / token_status != valid` 时硬跑
4. **绝不**把 lark-cli 偶发错误（网络/限流/proxy）归因到 token 失效 — 必须按 3.2-3.4 错误分类判断
5. **绝不**伪造 message_id / chat_id / 其他证据 — 不知道就说"未知"
6. **必须**每次操作前调 sidecar `/status` 拿最新 token 状态（token 长任务期可能失效）
7. **必须**临时错误 retry max 2 次 + 间隔 2s/5s
8. **必须**报告 retry 次数让 user 看到完整经历
9. **V3 必须**: `metadata.private_to` 非空时按步骤 0 严判,不一致一律拒绝,不要尝试"猜对意图"
10. **V4 必须**: 公开 issue 缺 `metadata.feishu_user_id` 时走 `creator_id` fallback (前提 `creator_type=member`); 私密 issue (private_to 非空) **禁止** fallback, 必须显式 metadata
11. **V4 必须**: 成功 comment 标注 `身份来源` 字段, 让审计能区分"显式 vs fallback"

## 常见 lark-cli 命令速查

| 操作 | 命令 |
|------|------|
| 发消息给用户 | `im +messages-send --user-id ou_xxx --text "..."` |
| 发消息到群 | `im +messages-send --chat-id oc_xxx --text "..."` |
| 创建日历事件 | `calendar +event-create --summary "..." --start-time "2026-..." --end-time "..."` |
| 读 wiki 节点 | `wiki +node-content-get --node-token wiki_xxx` |
| 搜员工 | `contact +user-search --query "张三"` |

详细参数：`bash ~/lark_multi_user/05_agent_spawn.sh $FEISHU_USER_ID <module> +<cmd> --help`

## V4 变更（vs V3，2026-05-29）

- **核心**: 公开 issue 缺 `metadata.feishu_user_id` 时,**自动 fallback 用 `issue.creator_id`** 作为 `FEISHU_USER_ID` (前提 `creator_type=member`)
- **理由**: multica 没 issue.created webhook,无法 server-side 自动注入 `metadata.feishu_user_id`。但 multica `user_id` 和 sidecar 用的 `multica_user_id` 本就同一个 id,所以只要用户绑定过飞书,`creator_id` 就能直接当 `feishu_user_id` 用 — **99% 普通 issue 不再报"缺 metadata"错**
- **新增 `身份来源` 字段**: 成功 comment 区分"显式 metadata vs creator_id fallback",可审计
- **私密 issue 限制**: `metadata.private_to` 非空时**禁止** fallback,必须显式 `metadata.feishu_user_id` (保安全边界)
- 新增**铁律 #10/#11**: V4 fallback 适用条件 + 标注审计字段
- 实施: 步骤 0 已经拿 `creator_id` `creator_type`,fallback 是纯 bash 逻辑,无额外 API 调用

## V3 变更（vs V2，2026-05-28）

- 新增**步骤 0 私密 issue 隔离检查**: `metadata.private_to` 非空时严判 `private_to == feishu_user_id`,不一致拒绝执行
- 新增**铁律 #9**: 不允许猜测对齐意图,只能让 issue 创建者手动改 metadata 后 rerun
- 安全模型: workspace 内 issue 公开 (没 per-issue ACL,by design),敏感场景靠 `private_to` metadata + skill 严判 + agent 调飞书身份独立隔离三层防护
- 实施: 步骤 0 + 步骤 1 共用一次 `multica issue get` 调用,无额外延迟

## V2 变更（vs V1）

- 加错误分类四档：OAuth 失效 / 临时错误 retry / 业务错误 / 未知（保守不归 token）
- 加重试机制：临时错误 max 2 次，2s/5s 间隔
- 加 V1 反模式禁令：不要把 lark-cli 偶发错误归因到 token（FUT-15 教训）
- 输出加"重试次数"字段，可追溯
- 提示 user 用授权 web UI（B 路径产出）而不是 sidecar /start API
