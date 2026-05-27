# 2026-05-27 晚 · 内测前 2 个挂起问题分析

> 川哥晚饭后提的两个真问题，明天去公司前必须解。完整调研 + 候选方案落盘。

---

## Q1 · 多用户 issue 之间互相看不到（隔离）

### 调研结论

**multica 当前没有 per-issue ACL**。issue 在 workspace 内默认全员可见——是协作平台 by design（类似 Linear / Jira default 公开）。

证据：
- `multica issue create --help` 无 `--private` / `--visibility` 任何 flag
- `multica project create --help` 无 visibility 字段，project 也是公开的
- workspace member 有 role (owner/admin/member) 但只控制 admin 操作，不控制 issue 可见性
- 二进制 strings grep 没看到 issue-level ACL keyword

| 隔离粒度 | 当前 multica 支持？ |
|---------|---------|
| workspace 级（不同 workspace 互不可见） | ✅ |
| project 级（project 内成员可见） | ⚠️ project 可建但 issue 还是 workspace 全员可见 |
| issue 级（指定 user 可见） | ❌ |
| comment 级（私密 comment） | ❌ |

### 3 候选方案

| 方案 | 工作量 | 优 | 劣 | 推荐场景 |
|------|-------|---|---|---------|
| **A. 多 workspace** | 30 min/人 | 真隔离 | 失去协作意义（连看到都不行） | 完全独立的小组 |
| **B. 接受透明协作** | 0 | 像 Linear default，团队互学 | 涉及隐私内容（HR 简历等）有泄漏风险 | **内测推荐起点** |
| **C. fork multica 加 ACL** | 3-5 天 | 真细粒度 | 每次 multica 升级要 merge | 规模化后再考虑 |

### 建议明天的分层策略

**业务 issue**（写代码 / 调研 / 内部讨论）→ B 透明协作

**敏感 issue**（HR 招聘 / 合同 / 个人飞书）→ B + **metadata 约定**：
- 创建 issue 时 metadata 加 `private_to=<user_id>`
- agent skill 加铁律: 处理前 check `metadata.private_to == issue.creator_id`，不匹配拒绝
- 不能防 UI 窥视，但能防 agent 误操作

**完全隔离的 HR 流程** → 单独建 HR-private workspace

**过早 over-engineering 反而拖慢内测节奏**。明天先按 B 启动，1 周后看哪些场景真的需要隔离，再决定。

### TODO

- [ ] 明天上午: 跟内测成员沟通"workspace 内 issue 默认互看" 心智
- [ ] 决策：是否所有内测共用 1 个 workspace（默认透明），还是按业务线分 2-3 个 workspace
- [ ] 如果要 metadata 约定隔离: 改 skill "飞书代理操作员" V3 加 private_to 检查
- [ ] 长期: 评估 fork multica 加 ACL 字段（看内测反馈紧迫度）

---

## Q2 · 邮件邀请收不到 ⚠️ 紧急

### 根因

QNAP `.env` 当前配置：
```env
APP_ENV=development              # ★ dev mode 根本不发邮件
ALLOWED_EMAILS=hahaxiong83@gmail.com   # ★ 只川哥邮箱允许
MULTICA_DEV_VERIFICATION_CODE=888888   # dev 用固定验证码替代邮件
# 没有 RESEND_API_KEY              # ★ 邮件 service 没配
```

3 个问题叠加: production env 没切 / 白名单只有川哥 / 邮件 service 没配。

### 修复路径 A — 临时（1 分钟，立即可用）

保持 dev mode，加白名单 + 通知大家用 `888888` 验证码：

```env
ALLOWED_EMAILS=hahaxiong83@gmail.com,<张三邮箱>,<李四邮箱>,...
MULTICA_DEV_VERIFICATION_CODE=888888    # 保留
# 其他不动
```

操作：
1. 你给 cc 内测成员邮箱清单
2. cc ssh prnas 改 .env + docker restart backend
3. ONBOARDING.md 加："注册验证码统一用 `888888`，不会有真邮件"
4. 团队成员注册时填 888888 → 通过

**限制**：所有人共用一个验证码，不安全 → 仅适合 10 人内测。

### 修复路径 B — 正式（半小时，邮件真到达）

1. **你做**: 注册 https://resend.com/api-keys 拿 `re_xxx` API key
2. **你做**: 决定发件域名（用 `multica.cli4.hahaxiong.cc` 子域加 Resend DNS TXT 验证，或用 Resend 默认 `onboarding@resend.dev` 测试）
3. **cc 做**: 改 .env
   ```env
   APP_ENV=production
   ALLOW_SIGNUP=false                    # production 必须白名单
   ALLOWED_EMAILS=hahaxiong83@gmail.com,colleague1@..,colleague2@..,...
   MULTICA_DEV_VERIFICATION_CODE=        # production 应忽略
   RESEND_API_KEY=re_xxxxxxxx
   RESEND_FROM_EMAIL=onboarding@<你定的域名>
   ```
4. **cc 做**: docker compose restart backend
5. 内测成员收真邮件 → 走标准 6 位 OTP 验证

### 我的推荐时间线

- **明天上午 9:00**：方案 A 立即 unblock（5 分钟 cc 改 .env），开始拉人
- **明天下午**：你顺手注册 Resend 拿 key
- **明天傍晚 / 周日**：切方案 B（cc 半小时）
- **下周一**：所有内测成员可用真邮件流程

### TODO

- [ ] **明天上午 P0**: 你给内测成员邮箱清单 → cc 改 .env ALLOWED_EMAILS + restart backend → 验证 RaymanChen 之外的 user 能用 888888 注册
- [ ] **明天下午 P0**: 你注册 Resend + 给 API key
- [ ] **明天傍晚 P0**: cc 切 production + RESEND_API_KEY + 实测发邮件到张三邮箱
- [ ] **下周 P1**: 配 Resend domain DNS (TXT/DKIM/SPF) 让发件人是 `noreply@multica.cli4.hahaxiong.cc`
- [ ] **下周 P1**: 给 ONBOARDING.md 加 "邀请后会收到来自 noreply@multica.cli4.hahaxiong.cc 的 6 位验证码邮件"

---

## 综合明天 9:00 之前的待办

| # | 责任 | 任务 | 时长 |
|---|-----|------|------|
| 1 | 你 | 整理内测成员邮箱清单（建议 2-3 人 PoC，验证后再扩） | 5 min |
| 2 | cc | 改 QNAP .env ALLOWED_EMAILS + docker restart backend | 5 min |
| 3 | cc | ONBOARDING.md 加方案 A 说明（验证码 888888） | 5 min |
| 4 | 你 | 邀请第一个内测成员（飞书 / 微信发 ONBOARDING + multica 登录链接） | 即可 |
| 5 | cc + 你 | 站台看第一个成员走 Step 1 + Step 2 全流程，记任何 friction | 15 min |
| 6 | 你 | 注册 Resend 拿 API key | 15 min |
| 7 | cc | 切方案 B + 实测邮件 | 30 min |

**整体明天上午 1 小时就能让内测真跑起来**。
