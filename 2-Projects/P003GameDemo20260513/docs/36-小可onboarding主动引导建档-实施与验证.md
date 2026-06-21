# docs/36 · 小可 onboarding 主动引导建档 — 实施与验证

> 关联：方案评估见对话（2026-06-21）/ 后端 onboarding 链路 docs/35 火山 RTC / 记忆 `feedback_p003_onboarding_voice_guided_profiling`。
> 日期：2026-06-21。状态：✅ 后端 E2E 全过 + 川哥真机实测通过 + 生产部署。

## 1. 需求

邀请码首次激活后、孩子档案没建全时，小可在**手机端实时对话**里主动引导孩子说出「昵称 / 性别 / 出生年月」，抽取后写回 profile.db（真相源，多端读它）。替代原来登录时的"手填表单"，改成对话式建档。

## 2. 川哥拍板的关键决策

| 决策 | 选择 |
|---|---|
| 采集方式 | **对话为主 + 表单兜底**（手机端去手填表单，家长端 parent 保留表单兜底） |
| 覆盖范围 | **手机端火山 RTC 优先**（体验台 WS pipeline 本期不动） |
| 生日采集 | **小可引导问家长**（孩子说不清就让家长 App 补，不卡退出） |

## 3. 判定口径（核心设计）

不依赖"邀请码 used_at 首次激活"这种一次性信号，而是靠**档案缺字段**自动进/出 onboarding —— 更鲁棒（断线能续、问全自动退）：

- `needsOnboarding(p) = 无档案 || 缺昵称 || 缺性别`。**生日不计入退出判定**（走家长兜底），但 onboarding 话术里仍会问生日。
- 昵称+性别一齐 → `needsOnboarding=false` → 自动退出，回归正常人设，不再追问。

## 4. 实现（手机端火山 RTC 链路）

| 文件 | 改动 |
|---|---|
| `apps/server/src/onboarding-extractor.ts`（新） | 从对话抽孩子首次自报的昵称/性别/生日。归一化（中文数字→阿拉伯生日、性别男女归一、年龄推不出年月必拒）+ 防注入（三引号数据边界、昵称合法性校验、剥自报话术前缀）。`parseOnboarding` 导出供单测 |
| `apps/server/src/profile-store.ts` | `upsertBasics`（逐字段增量建档，复用 upsertProfile 同步原子）+ `needsOnboarding`（导出，含 `?? ''` 字段防御） |
| `apps/server/src/prompt-orchestrator.ts` | `buildOnboardingGuide`（缺哪个问哪个的引导话术）+ `assembleSystemPrompt` 加可选 onboardingGuide 参数，**注入在最末尾**（见 §6 坑） |
| `apps/server/src/routes/custom-llm.ts` | onboarding 期注入 guide + 每轮异步抽取（fire-and-forget，失败不阻断 SSE）→ upsertBasics |
| `apps/server/src/routes/rtc.ts` | `/start` 按 needsOnboarding 动态切 WelcomeMessage（onboarding 进房第一句先自我介绍+问名字） |
| `apps/web/src/mobile/MobileLogin.tsx` | 删手机端 profile 手填表单残留：没建档直接 setToken 进小可界面，由对话采集接管 |

## 5. team 模式开干流程（路 C + 三发评审）

1. **cc 主笔** onboarding-extractor.ts（含话术 + 安全，不外包）
2. **路 C**：cc 写 spec → codex 出 13 个 Search/Replace 块 → `apply-blocks.py` 原子落盘（0 failed）
3. **cc 判官**：git diff 核对（话术逐字照搬）+ tsc 全量类型门
4. **team 三发对抗评审**（grok+codex+gemini）抓 5 个真问题（全修）+ 3 个误报（核验源码排除）
5. **cc 双门验收** + 后端 E2E + 川哥真机

### team 评审抓到的 5 个真问题（已修）
- 🔴 failsafe：`needsOnboarding`/`buildOnboardingGuide` 的 `.trim()` 在 custom-llm 顶层无 try-catch 包裹，异常字段会断 SSE → `?? ''` 防御
- 性别否定误判：`normalizeGender` includes "不是男孩是女孩" 会判男孩 → 同含男女即拒
- 中文数字生日：normalizeBirthday 只认阿拉伯 → 加 cnToArabic 兜底
- 昵称话术前缀："我叫天天"整句入库 → stripNamePrefix
- emoji 截断：clip 先 join 后 slice 砍断 surrogate pair → 字符数组阶段 slice

## 6. 关键坑：近因效应（docs/24 同源）

**onboarding guide 第一版注入在 prompt 中间，E2E 发现 LLM 不 follow** —— 小可仍用世界观默认开场"指挥官你好，去哪片星域探险"，不问名字。根因：`ARK_WORLDVIEW_BASE` 的强开场人设在 prompt 开头，guide 在中间被盖过。

修复：①guide 移到 prompt **最末尾**（recency 最高）②措辞强化"【本轮最高优先】先认识孩子，不是喊指挥官、不是急着探险"。修复后 E2E：轮1 主动问名字 ✓、轮2 接住+问性别 ✓。

## 7. 验证

- **单测** `npm run test:onboarding`：25 passed（归一化/校验/去重边界）；既有测试 95 passed 零回归；tsc 全量 0 错。
- **后端 E2E**（生产 curl 模拟火山回调）：① 新孩子进入 onboarding 主动问名字 ② 多轮引导接住名字→问性别 ③ 抽取写回 DB ④ 已建档孩子自动退出+认得+回归正常人设。
- **真机**：川哥手机端实测通过（跳过表单 + 对话引导 + 记忆）。

## 8. 待办（后续）

- 前端 localStorage birthday 回源（手机端记忆走 DB 不依赖它，仅 UI 显示，第二阶段）
- 观察生日实际采集率（昵称+性别齐就退出，生日靠家长兜底；若需更坚持问生日，调退出判定）
- 体验台 WS pipeline 同步 onboarding（本期手机端优先未做）
- `/v1` 端点鉴权 + 限额（防白嫖 Gemini）

## 9. 回滚

- server：`cp /opt/p003/_backup/20260621-153810-onboarding/{profile-store,prompt-orchestrator}.ts /opt/p003/server/src/` + `cp .../routes/{custom-llm,rtc}.ts /opt/p003/server/src/routes/` + 删 `src/onboarding-extractor.ts` + `pm2 restart p003-voice`。
- web：`git revert` MobileLogin 改动 + 重 build + rsync。
