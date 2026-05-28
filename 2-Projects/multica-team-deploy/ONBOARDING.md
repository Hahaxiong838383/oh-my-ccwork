# Multica × 飞书集成 · 团队成员上手指南

> 5 分钟搞定：multica 账号 → 飞书授权 → 派任务给 agent 操作飞书。
> 任何问题找川哥（hahaxiong83@gmail.com）。

---

## Step 1 · 注册 multica 账号

> 已经收到川哥邀请邮件的，跳过此步直接 Step 2。

1. 打开 **https://multica.cli4.hahaxiong.cc**
2. 用以下任一**白名单邮箱**注册 / 登录：
   - `hahaxiong83@gmail.com`（川哥）
   - `xinrun.li@futurus.co`
   - `rayman.chen@futurus.co`
   - `ping.yang@futurus.co`
3. **当前 dev 模式不发真邮件**，邮箱验证码统一填 **`888888`**（10 人内测临时方案，下周切真邮件）
4. 完成 onboarding 问卷（30 秒）

完成标志：能看到 multica 工作台 + 你头像在右上角。

---

## Step 2 · 飞书账号绑定（一次性，30 秒）

1. **保持 multica web tab 开着**（不要登出）
2. 打开 **https://multica.cli4.hahaxiong.cc/oauth-ui**
3. 页面会自动检测到你 multica 当前登录用户 ID，**直接显示飞书 QR 二维码**
4. 用手机飞书扫码（或点页面下方"打开飞书授权页"链接手动完成）
5. 看到 "✅ 授权成功" 即完成

完成标志：
- 页面显示你的飞书姓名 + open_id
- 后续任何 multica issue 派给"飞书代理操作员" agent 时，agent 会用**你的飞书身份**执行（消息署名你本人）

### Step 2 可能遇到的问题

| 现象 | 原因 | 解决 |
|------|------|------|
| 页面显示"未自动检测到" + 输入框 | multica session 没带过 cookie | 确认 Step 1 的 multica tab 还登录着，刷新本页 |
| QR 已生成但扫码后状态没切换 | sidecar 后台 polling 没完成 | 等 30s 自动切换。仍未切换刷新页面 |
| "授权链接已过期" | 10 分钟内没完成扫码 | 点"重新开始"按钮 |
| 扫码后飞书 app 提示"已授权过" | 之前授权过 | 正常，等页面切换即可 |

---

## Step 3 · 派任务让 agent 操作飞书

multica web → 创建 issue → 指派给 "飞书代理操作员"（agent）：

**关键步骤**：issue 创建后**必须**在 issue 详情页加 metadata `feishu_user_id` = 你的 multica user_id。

未来 multica web 完整集成后会自动注入（P0-1c TODO），目前先手动：

1. issue 创建后，点 issue 顶部"Metadata"标签
2. 加一个 KV：key=`feishu_user_id`，value=你的 multica user_id（在 multica web 个人设置页可看，或者直接在 oauth-ui 授权成功页复制）
3. issue 自动派给 agent，等结果

### 示例任务

| 类型 | issue description 写 |
|------|----------------------|
| **发飞书消息** | 请给 `ou_xxx`（飞书 openid）发消息内容："会议提醒：明天下午 2 点视频会" |
| **创建飞书文档** | 请创建一个 docx 标题"YYYY-MM-DD 周报"，写入内容："本周完成 X / 下周计划 Y"，返回 URL |
| **读 wiki 节点** | 请读取 wiki 节点 `wiki_xxx`，总结 200 字内 |
| **查日历** | 请查我下周的日程，列出所有非内部会议 |

agent 严格按 [飞书代理操作 skill V2](feishu-oauth-integration/skill-feishu-as-user.md) 流程执行：
- 先验证你的 token 还 valid（每次操作前都验证）
- 调用 lark-cli 完成 → 返回真实 message_id / document_id 作为证据
- token 失效会拒绝执行 + 提示你重走 Step 2

---

## Issue 可见性与隔离 ⚠️ 必读

> 这是 multica 当前架构的**重要心智**，避免误把敏感内容放到公开 issue 里。

### 默认：workspace 内全员透明

multica 当前**没有 per-issue ACL**。同一 workspace 里所有 issue **互相可见**（包括 description / comment / metadata / agent 产出）。这是协作平台 by design（类似 Linear / Jira 默认公开）。

**意味着**：
- ✅ 业务 issue（写代码 / 调研 / 内部讨论）— 团队互看互学，OK
- ⚠️ 敏感 issue（HR 简历 / 合同 / 个人隐私 / 第三方机密）— **会被同 workspace 其他成员看到**

### 处理敏感内容的 3 个选择

| 场景 | 建议做法 |
|------|---------|
| 偶尔涉及个人隐私（如让 agent 写一封私人邮件） | issue.metadata 加 `private_to=<你的 multica user_id>`，agent skill 会 check 不匹配就拒绝执行（不能防 UI 窥视，但能防 agent 误操作给别人转发） |
| 持续处理 HR / 合同等敏感流程 | 跟川哥申请单独建 **HR-private workspace**，只拉相关人，物理隔离 |
| 第三方机密（合作方 NDA 等） | **不要放 multica**，走线下 / 加密渠道 |

### Agent 调你飞书身份的隔离（独立于 issue 可见性）

issue 内容大家能看，但**调飞书 API 用谁的身份**是严格隔离的：
- agent 用 `issue.metadata.feishu_user_id` 对应那个人的 token，**不是 issue 创建者，也不是 workspace owner**
- 没注入 `feishu_user_id` → agent 拒绝执行
- 即使 owner（川哥）也**不能**冒用你的飞书身份发消息（skill 铁律）

### 试用反馈

如果你发现某个场景"必须 issue 级隔离才能用"，跟川哥说，会评估是否 fork multica 加 ACL 字段（当前是接受透明、必要时分 workspace）。

---

## 安全说明

- **你的飞书 token 只存在 mini 上**（multica daemon 主机），multica server 后端**不存** token
- agent 在 issue 内调飞书时**只代理 issue.metadata.feishu_user_id 对应的 user**
- workspace owner（川哥）也**不能**用你的飞书身份发消息（skill 铁律：绝不用 owner 身份执行别人 issue）
- token 7 天自动 refresh，过期会通知你重新扫码

---

## 故障速查

| 现象 | 排查 |
|------|------|
| oauth-ui 页面打不开 | 检查 https://multica.cli4.hahaxiong.cc/healthz 是否 200 |
| 派的 issue 一直 todo 没动 | 川哥端检查 daemon `multica daemon status` |
| agent 报"token 过期" | 重走 Step 2 重新扫码 |
| agent 报"binding_not_found" | issue.metadata 没注入 feishu_user_id |
| 一直说"未自动检测到 user" | 没在另一 tab 登录 multica / cookie 被清 |

---

## 你需要知道的内部链接

| 资产 | URL |
|------|-----|
| multica web | https://multica.cli4.hahaxiong.cc |
| oauth-ui（飞书授权） | https://multica.cli4.hahaxiong.cc/oauth-ui |
| sidecar 健康 | https://multica.cli4.hahaxiong.cc/healthz |
| sidecar status API | https://multica.cli4.hahaxiong.cc/api/feishu/device/status?multica_user_id=`<你的id>` |

---

**有问题直接飞书 @川哥**。
