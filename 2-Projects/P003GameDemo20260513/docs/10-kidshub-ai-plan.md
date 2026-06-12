# KidsHub-AI · 小可 Prompt 体验工作台（2026-06-11）

## 定位

同仓库新路由 `/kidshub-ai`：左栏选《小可 AI 产品定义》的版块/场景卡，中栏 800×480 设备画布真语音对话，右栏可编辑 prompt 立即下发验证。

- **主用户**：产品经理——基于小可实际表现调 prompt，验证测试用
- **次用户**：工程师——看调整后生效的 prompt 配置（导出/调试流）
- 事实源：《小可 AI 产品定义》V2.0（飞书 wiki ZsI5w9N8WiUbsHkzfeicSKXRnJf）
- 原 demo `/` 路径一行不动（回归底线）

## 架构决策

1. **组装在前端，server 只存只用**：前端 `composeSystemPrompt()`（全局模板 ← {scene_prompt} ← 场景卡，再替换变量）组装出完整 system prompt，经 ws `session.config` 下发；server 存到当前连接的 pipeline，LLM 调用时使用并回发 `debug.prompt_assembled`（所见即所发，无双端模板逻辑漂移）。
2. **Prompt 资产数据化**：`apps/web/src/kidshub/prompts/` 逐字搬运产品定义原文（全局 Prompt / 八卡 / 6 变量 / B 版块），代码里不改写产品话术；变量 mock 默认值与卡示例话术对账一致（30 颗星尘 / 小鱼新花纹 / 喜欢恐龙）。
3. **登录 demo 级**：凭据在 server `.env.local`（STUDIO_USER / STUDIO_PASS，gitignored），`POST /api/auth/login` 发内存 token；页面级控制，ws 不加 auth（不破坏原 demo）。
4. **共享文件只由主线改**：main.tsx（pathname 分流）、voice-client.ts（+sendSessionConfig / +debug 事件透传）、server 三文件；协作引擎只写 `kidshub/` 新目录，零文件交集并行。

## ws 协议增量

- C→S `{type:'session.config', systemPrompt}`（≤32000 字符，decodeClientMessage 白名单已加）
- S→C `{type:'session.config.ack', chars}` / `{type:'debug.prompt_assembled', systemPrompt, userText}`

## 分工（team 模式）

- cc：prompts 资产、server（pipeline/index/auth）、voice-client、main.tsx 分流、集成验收
- grok（grok-build high）：kidshub/ 全部 UI（登录 + 三栏 + store + 调试流）
- codex：因订阅 OAuth 不支持 gpt-5.5-codex 模型首发失败，server 改由 cc 接管；留对抗审查

## 踩坑记录

- **Node `--env-file` 的 `#` 行内注释**：`STUDIO_PASS` 的值含 `#` 被截断成前半段，登录 401。修复：值加双引号。env 值含 `#` 必须加引号。
- corepack 损坏（Cannot find module './lib/corepack.cjs'）：pnpm 不可用，用仓库根 `node_modules/.bin/{tsc,vite}` 直跑。
