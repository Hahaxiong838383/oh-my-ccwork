# D6 完整复盘（2026-05-18）

> V0.9 → **V1.0** · 16 commit · 表情感知 A' 架构端到端 · Team 模式 cc/codex/gemini 三引擎协同 · 一天打通

## 目标演化

D6 起手是给小可加"看到表情"的人设感：摄像头抓拍 → Gemini Vision 识别表情 → TTS 前缀拼接（"看你笑得这么开心，..."）。

**最终 V1.0**：

- 12 标签丰富表情谱（含 happy/sad/excited/curious/focused/thinking 等）
- A' 架构：scene 切换瞬间预抓拍 + 5s 后台兜底，ttsSpeak **零等待**（保 D5 字幕严同步）
- vision 端到端 **1.6-2.1s**（6s → 改善 70%）
- 端到端真机演练通过（iOS Safari + iBRO 10.9.1.104）

## 时间线与决策

| Phase | Commit | 核心改动 | 触发 |
|---|---|---|---|
| **规划阶段** | | | |
| P0 | `ad2a7ecc9` | V0.1 规划评审稿 + V0.9 回滚锚点 tag `p003-v0.9-stable` | 川哥要做表情感知 |
| P0 | `a239b335f` | V0.2 整合稿（codex 工程 NEEDS_FIX + gemini 产品 NEEDS_TWEAK 双评审采纳）| 双引擎并行评审 → 拒绝 codex 的"滞后一拍" A 方案（90% 单句场景失效）→ 落 A' |
| **实施阶段（team 模式）** | | | |
| P1 | `ef8460db4` | 团队并行 codex A 前端（4 新 + 4 改）+ codex B 后端（2 新 + 1 改），cc 主线契约 Gate + 双 typecheck | A' 架构落地，581 行 / 11 文件 |
| **真机踩坑链** | | | |
| P2 | `ddfb5f2f0` | cc 自测发现 vite proxy 只 ws/voice 不转 /api，加 4 行 proxy | curl 测 5173 时 404 |
| P3 | `9b6a039c9` | 表情诊断面板（DebugBar 加 5 flag 实时显示 + 手动 snap + 清旗）+ catch 路径补 lastSkip | 川哥真机看到 last=posting 卡死 |
| P4 | `9c56b5def` | client fetch timeout 1.5s→5s（iOS Safari + WiFi + Gemini 实测 2-3s）| 真凶：1500ms < server 3000ms 兜底，client 先 abort |
| P5 | `5862d7609` | 离屏 video 1×1→160×120（iOS Safari 1×1 停帧解码）| 摄像头预览出来了但 Gemini 总判 no_face |
| P6 | `62e6f3aa1` | 强制 `facingMode: 'user'` 前置（iOS Safari 默认后置）| cc 误判 — 川哥反馈"我拍的是前摄画面"|
| P7 | `b9b405fcb` | prompt 去"儿童"偏置 + server 加 raw 响应 log | 川哥前置正脸清晰但 Gemini 仍判 no_face — 怀疑 prompt 偏向"儿童" |
| **真凶逮捕** | | | |
| P8 | `925ced525` | **真凶**：Gemini 3 thinking 模型 `reasoning_tokens=112` 吃掉 `max_tokens=120` → content 截断为 0 → 兜底 no_face。修：max_tokens 120→4096 | server log 显示 `gemini raw content: undefined` + `finish_reason: "length"` |
| P9 | `d03f0f8bf` | max_tokens 4096→65535 拉满 | 川哥说"都设置为最大" |
| **命中率优化** | | | |
| P10 | `1270a07ba` | 三件套：prompt"偏向找表情" + confidence 0.8→0.6 + jumpToScene snap() force（不复用缓存）| Gemini 对自然脸偏 neutral/no_face@1.0 |
| **速度优化** | | | |
| P11 | `20fe65689` | **perf**：vision 6s→1.6-2.1s。换模型 + 关 thinking + 图压：① `gemini-3-flash-preview` → `gemini-2.5-flash`；② **`extra_body.google.thinking_config.thinking_budget: 0`**（Vertex 原生关 thinking，代理透传）；③ 图 320×240 q=0.7 → 160×120 q=0.6；④ confidence 阈值 0.6→0.5 | 川哥反馈"识别速度偏慢"。cc + codex + gemini 三路调研后落 |
| **人设感强化** | | | |
| P12 | `69409fd2c` | neutral 加 `'嗯，'` 前缀（A 方案）| 川哥实测 67% neutral → V0.2 §9.1 设计 neutral 空前缀 = 永远不触发 |
| P13 | `96eb822aa` | V2 表情扩到 13 标签（加 sad/surprised/focused/excited/bored/shy/confused/thinking）| 川哥："越丰富越好" |
| **真凶逮捕 #2** | | | |
| P14 | `14ed2738d` | **真凶**：`isExpressionLabel` 函数 V2 漏改，只校验旧 5 标签 → 新加 8 标签**全被 parseVisionResponse 拒** → currentRef 永走兜底。修：用 Set + 12 标签 + 删 neutral + 阈值 0 | 川哥"小可 TTS 没基于表情"——server 返了 happy/sad 等，client 默默兜底 |

## 三大踩坑根因（沉淀给后续）

### 坑 1：Gemini 3 thinking 模型 `reasoning_tokens` 隐式吃 max_tokens

**症状**：vision 端口 200 + `expr=no_face conf=0.00`，server log 显示 `gemini raw content: undefined`。

**真凶**：Gemini 3 是 thinking 模型，response 含 `reasoning_tokens: 112`。`max_tokens=120` 被 reasoning 吃光 112，剩 8 给 content，输出 4 token 后 `finish_reason: "length"` 截断 → content 字段直接缺失。

**修复路径**：
1. 排查时**必须 dump 完整 response**，单看 content 字段会误以为是 Gemini 真返 no_face
2. `max_tokens` 给 thinking 模型必须留充裕（4096 起步，否则 reasoning 吃光剩多少都不够 JSON 输出）
3. 想真正关 thinking：`extra_body.google.thinking_config.thinking_budget: 0`（Vertex 原生，OpenAI 兼容代理透传），可以杀掉 reasoning_tokens 这一项

**关键约束**：`reasoning_effort` 和 `thinking_config` **不能同时传**，代理 400 INVALID_ARGUMENT：`Expected one of either reasoning_effort or custom thinking_config; found both.`

### 坑 2：多路 codex 后白名单同步不彻底

**症状**：V2 扩到 13 标签，server 端 zod 校验 + prompt 都改了，但 client 端 `isExpressionLabel` 函数还停留在旧 5 标签 → Gemini 返 `happy/sad/excited` 等被 parseVisionResponse **静默拒掉** → currentRef 永远走兜底 → TTS 没基于表情。

**真凶**：扩 union 类型时，**白名单实现必须同步**（zod / parser / 类型守卫 isXxx 函数）。类型守卫不会被 tsc 编译期捕获（它检查的是 runtime string 字面量）。

**修复路径**：
- 扩标签 union → grep `isExpressionLabel|LabelSchema|EXPR_INTRO` 全部消费方
- 用 Set + 类型 union 共享数据源（一处定义，多处用），不要硬编码字符串列表分散
- 多路 codex 改完后 cc 主线必须做"字段对齐 Gate"——这次 cc 漏检查了 client parser

### 坑 3：iOS Safari + getUserMedia 三个陷阱串联

**症状链**：
1. **`facingMode` 默认后置摄像头** → 川哥前面看屏幕，但摄像头拍后面 → Gemini 永远 no_face
2. **1×1 离屏 video 不解码帧** → drawImage 拿到全黑 / 不完整 → Gemini 也 no_face
3. **getUserMedia 必须用户手势栈** → setInterval 后台调会拒（cameraUnavailable 持久化）

**修复路径**：
- 强制 `facingMode: { ideal: 'user' }`
- 离屏 video 改 `top: -9999px + opacity: 0` + **真实尺寸 160×120**（不能 1×1）
- 授权挂用户手势栈按钮 onClick（DebugBar 完成配网按钮 onClick 内）

## 团队协同模式（D6 最大产出）

D6 16 commit 里只有 1 commit（codex A + B 并行实施）是 codex 真正写代码 / 多次评审用 codex + gemini，其余 cc 主线诊断 + 修复。

**模式**：
- **规划阶段** → codex（工程评审 NEEDS_FIX）+ gemini（产品 NEEDS_TWEAK）双引擎并行评审 → cc 整合落 V0.2
- **实施阶段** → codex A（前端）+ codex B（后端）并行写代码 → cc 主线契约 Gate（前后端字段对齐）+ typecheck + commit
- **真机踩坑** → cc 主线单路调试（不派 agent，因为需要川哥真机交互的快速来回）
- **速度优化** → 再次双路 codex（工程）+ gemini（产品）评审 + cc 综合

**关键经验**：codex 调研 + 评审强，但 **cc 自己写 prompt 时必须明确"禁推"避免 codex 把所有字段都给改了**（比如 codex A 写 expression-snapshot.ts 时漏校 isExpressionLabel 函数 — 因为 prompt 没指定）。

## 工程范式沉淀

1. **A' 架构 = "事件预抓拍 + 后台兜底"**：不让 fetch 阻塞主流程，用 demo 自身的过场动画时间换异步延迟
2. **Gemini Vision 接 OpenAI 兼容代理的关 thinking 套路**：`extra_body.google.thinking_config.thinking_budget: 0`
3. **多路 codex 后契约 Gate 模板**：union / zod / parser / EXPR_INTRO / isXxx 类型守卫 / 文档示例 6 处必须同步 grep 验证
4. **iOS Safari getUserMedia 三件套**：facingMode user + 160×120 离屏（非 1×1）+ 用户手势栈触发

## 演示流程（V1.0）

```
手机 https://10.9.1.104:5173/ → 完成配网（DebugBar 按钮，触发摄像头授权）
  ↓ 抓拍 → Gemini Vision (1.6-2.1s) → currentRef.expr 更新
  ↓ 跳关 1: Welcome （小可："看你这么期待，你好，指挥官！..."）
  ↓ 跳关 2: 夜航报告（小可："看你笑得这么开心，夜航报告出炉..."）
  ↓ ... 11 场景全程小可带表情前缀
  ↓ DebugBar 第 2 行实时显示 bound/stream/mdev/unavail/last 5 flag
```

## 后续 TODO

| P | 项 |
|---|---|
| P1 | 真机现场暗光 / 逆光 / 侧光压测（演示场地光线复杂） |
| P1 | confidence 分布统计（实测 happy/sad/curious/no_face 命中比例）|
| P2 | 多帧投票（最近 3 帧滑动窗口取 mode）防瞬时误判 |
| P2 | "看到你啦" 首次抓拍成功 trigger（V0.2 §9.2 没实现）|
| P3 | 摄像头拒绝场景 0.3 概率说"我看不到你呢"（V0.2 §9.3 没实现）|
| P3 | DebugBar debug 面板清理（demo 上线前隐藏 5 flag 行）|
| P4 商业化 | 端侧 MediaPipe Tasks Vision 替换云端 Gemini（合规 + 零延迟）|

## 沉淀文档与记忆

- [V0.2 规划稿](./D6-vision-expression-plan.md)（含 codex + gemini 双评审整合）
- [feedback_gemini_thinking_budget_zero.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/) — thinking_budget=0 关 thinking + reasoning_effort 互斥
- [feedback_ios_safari_getusermedia_traps.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/) — iOS Safari 三件套
- [feedback_codex_multi_field_whitelist_sync.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/) — 多路 codex 后白名单 6 处同步
- [feedback_vite_proxy_api_path.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/) — vite proxy 默认不转 /api
- [feedback_long_running_vite_dev.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/) — vite dev 长跑（22h）僵死

---

## D6 P2：VPS 公网部署（8 commit）

D6 P1 完工当晚川哥同步：部署到阿里云 HK 8.218.26.17，域名 p003.hahaxiong.cc。

| Phase | Commit | 改动 | 真凶 / 踩坑 |
|---|---|---|---|
| **现状探查** | — | SSH 8.218.26.17 看：1.6Gi 内存 / cc-remote V4 frps + nginx 80/443 已占 / 无 node/npm | 资源紧但 1.1Gi 可用够，避开 7000/19080/19443/22022/29443 端口选 :3001 |
| **基础设施** | — | nodesource setup_22.x → Node v22.22 + 装 + 建 /opt/p003/{server,web/dist} | rsync + certbot 系统已装 |
| **代码上传** | — | rsync web/dist + apps/server → VPS（含 24 PNG+MP4 美术资产）| 17M / 24 asset 全到位 |
| **systemd unit 起步崩 #1** | — | exit 127 = command not found | `--omit=dev` 跳过 tsx（tsx 是 devDep），改 npm install 完整装 |
| **真凶逮捕 #3** | `a72f47284` | server/package.json **漏 zod dependency** → ERR_MODULE_NOT_FOUND | codex B 写 vision.ts 用 zod 但忘加 dep；本地 monorepo root 共享 zod 掩盖了，独立部署 VPS 才暴露 |
| **nginx 语法陷阱** | — | reload 失败 `unknown directive "http2"` | nginx 1.24 不支持 `http2 on;` (nginx 1.25+ 语法)；改老语法 `listen 443 ssl http2;` |
| **certbot 装证书失败** | — | "Could not automatically find a matching server block for p003.hahaxiong.cc" | vhost 只有 listen 80 没 listen 443，certbot --nginx 找不到。手写完整 80+443 vhost 后重 reload，证书自然挂上 |
| **SSL 不匹配假象** | — | Mac 端 curl 首次报 SSL 不匹配，VPS 端 5/5 都 200 | Mac 端 SSL session resumption 缓存旧 TLS ticket；重试或 keep-alive 自然恢复 |

**端到端时延实测**：
- /health: VPS 端 5/5 全 200，5ms 内
- POST /api/vision/expression: 公网 1.1s（含 Gemini 0.85s）
- 静态 PNG: HTTP/2 200，nginx 30d expires 缓存
- 80→443 redirect: 301 OK
- 证书: Let's Encrypt CN=p003.hahaxiong.cc, 2026-08-16 到期

## D6 P2 + P3：川哥真机迭代两轮（4+4 反馈）

### 第一轮 D6 P2（commit `65f5e29eb`）
| Q | 修复 |
|---|---|
| Q1 出航宝箱切换太快 | focus-machine `FOCUS_REWARD_READY` → 加 `rewardOpenDelay=1500ms` timer，setFocusStage='full' 后等"变黄"美术展示完再 dispatchRandomBox |
| Q2 收获奖励变黄就能点 | RewardClaimButton 条件改 `focusStage ∈ {openable, full}`（≥60% 起，原 ≥100%）|
| Q3 生态缸按钮各关卡都能选 | DebugBar 去掉外层 `focusMachine === 'idle' && rewardMachine === ...` 包裹常驻 |

### 第二轮 D6 P3（commit `1aa3ea88b`）
| Q | 修复 |
|---|---|
| Q1 开宝箱后跳转还是太快 | rewardShownMsFor 公式从 `220ms/字 + 2.2s buffer` 提到 `280ms/字 + 3.5s buffer`，clamp [4.5s,7.5s] → [6.5s,10s] |
| Q2 继续/返舱按钮过小 | AskMode 按钮 minWidth 16→22cqw, fontSize 2.6→3.6cqw, paddingBlock 1.9→3cqw |
| Q3 宝箱 UI + 文字过小 | OpenBox 整体 ~1.4 倍放大：品质标签 2.4→3.4cqw, 圆环 20→27cqw, 宝箱 16→22cqw, 奖励块 2.5→3.4cqw, 小可文案 2.1→3cqw |
| Q4 去左下角 debug 角标 | Screen.tsx 删 `<SceneNumberBadge />` 渲染（组件保留方便回切） |

## D6 整体复盘（P1 + P2 + P3 + VPS = 24 commit）

| 阶段 | Commit 数 | 关键产出 |
|---|---|---|
| P1 表情感知（含规划）| 16 | A' 架构 + 12 标签 + 1.6s 延迟 + 7 commits 真凶链 |
| VPS 部署 | 2 | p003.hahaxiong.cc HTTPS 上线 + zod fix |
| P2 真机反馈第 1 轮 | 1 | reward 缓冲 + 变黄即点 + 生态缸常驻 |
| P3 真机反馈第 2 轮 | 1 | reward 再加长 + 按钮 + UI 放大 + 去 debug |
| 文档收尾 | 4 | D6-log + README + RECENT_EVENTS + memory |

## 关键新沉淀 memory（D6 P2/P3 + VPS）

- [feedback_monorepo_deps_vs_standalone_deploy.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/) — monorepo root node_modules 共享掩盖 sub-package.json 漏 dep，VPS 独立部署才暴露
- [feedback_nginx_1_24_vs_1_25_http2_syntax.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/) — nginx 1.24 `listen 443 ssl http2;` 老语法 vs 1.25+ `http2 on;` 新语法
- [feedback_certbot_nginx_needs_443_block.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/) — certbot --nginx 自动装证书前必须先有 listen 443 ssl server block
- [feedback_pwa_sw_deploy_verify.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/) — PWA SW 新版上线靠 JS hash 对比验证（curl `/` grep index-XXX.js）

---

**川哥总评（D6 完整）**：D6 P1 表情感知功能上线 → 一夜 VPS 部署 + 川哥真机迭代两轮节奏抛光。**小可既能"看见"用户表情，也能在公网 demo 现场流畅交互**——demo 第一原则全程守住。

---

## D6 P4-P10：真机迭代第 3-6 轮（7 commit · 一夜抛光夜航报告 + 主流程顺序）

D6 P3 收尾当晚川哥再开 4 项反馈，加上后续连发，到 P10 共 7 commit 完成"夜航报告完整 UX + 主流程顺序修复 + PWA 强制更新"三件大事。

| Phase | Commit | 核心改动 | 触发 / 真凶 |
|---|---|---|---|
| **P4** | `4b403cf9c` | 夜航放大 1.4× + 加"🎁 收取奖励"按钮 + NextStepButton 顺序修复 | 川哥真机反馈"夜航过小+下一步跳错关卡"。真凶：`deriveCurrentScene` reward 子状态优先于 focus 主状态 → focusRunning 进度满后 rewardMachine='openingBox' 误推 box scene → NextStepButton 从关卡 4 跳关卡 7 而非 5。修：focus running/launching/paused/confirmExit 优先返 focusRunning/focusCompanion |
| **P5** | `882d038f9` | 夜航底部"新解锁"文字截断修 + 收取按钮挪信纸内右上角 | 字号 P4 放大后底部内容溢出。修：信纸 bottom 22→6% 吃满弹窗，按钮 absolute top/right + h2 顶对齐 |
| **P6** | `39769a08a` | 收取按钮放大到 RewardClaimButton 视觉等级 + 触发开箱体验 | 川哥要"按钮再大+点击触发开箱"。改 h2 + 按钮 flex row 内联；onClick `dispatchReward({OPEN_BOX})` 抽 randomBoxes 最高品质 + `dispatchBoot({NIGHT_REPORT_DONE})` 同步切 askMode |
| **P7** | `7a1dcb6f6` | NightReport z 层冲突修（rewardMachine ∈ {openingBox, showingReward} return null）| 川哥"点击没跳到开宝箱场景"。真凶：NightReport `z-layer-modal=80` > OpenBox `z-layer-mask=70`，OpenBox 渲染但被信纸盖住。P7 改 NightReport 让位（后续 P9 撤回，改 z 升级路径） |
| **P8** | `6660a028a` | NightReport 按钮加 `pointer-events-auto` | 川哥再报"按钮没反应"。真凶：P6 改 flex row 时漏抄 P5 absolute 版本的 `pointer-events-auto`，外层 NightReport 容器 `pointer-events-none` 会继承到子级，按钮 click 被吞 |
| **P9** | `0070a943c` | 收取奖励后保持夜航背景 + 开箱完才切 askMode | 川哥"开完直接跳没缓冲"。改 onClick **只** dispatchReward（不 dispatchBoot），等 rewardShown timer 完才切；OpenBox `z-layer-mask` → `z-layer-modal` 平 z + DOM 后渲染天然盖上；machines/index.ts `rewardShown` timer case 加 `bootState='nightReport'` 分支 → 切 askMode（不进 reward askMode "继续/返舱"）|
| **P10** | `13860e6b1` | PWA SW skipWaiting/clientsClaim 强更 + SCENE_ORDER 移除 box* | 川哥再报"开完进生态缸"。真凶：川哥手机 PWA SW 缓存 P7/P8 旧 JS（onClick 仍同步 dispatchBoot 立即切 boot + legendary 抽中走 ECO_CHECK）。修 1：workbox skipWaiting+clientsClaim 强制新 SW 立即激活。修 2：SCENE_ORDER 删 boxCommon/Rare/Epic/Legendary 让 NextStepButton 按主流程 4→5 而非 4→6 |

## D6 P4-P10 核心踩坑（沉淀）

### 坑 4：PWA SW 客户端缓存隐形老 JS
川哥 D6 P9 后仍报"老 bug 复现"，真凶不是代码不对——是 SW 在拦截 fetch 用 cached 旧 JS。**vite-plugin-pwa autoUpdate 默认不强制 skipWaiting**，新 SW 装在后台但不接管现有 client。修：workbox `skipWaiting: true` + `clientsClaim: true` 强制激活。

### 坑 5：pointer-events-none 父级继承吞子级 click
NightReport 容器 `pointer-events-none`（避免遮 demo 背景交互），子按钮要点必须 `pointer-events-auto` 显式覆盖。P6 从 absolute → inline flex 重构时漏抄 P5 的 `pointer-events-auto` → click 被吞，cc 误报"按钮没反应"。

### 坑 6：z 层 + DOM 顺序双因素决定视觉栈
P7 时 OpenBox z=70 < NightReport z=80，即使 DOM 后渲染也被盖住。两种修：① 升 OpenBox z 到 80 + DOM 后渲染天然在上（采用）② NightReport return null 让位（P7 临时方案，P9 撤回）。**记住数字大优先于 DOM 顺序**。

### 坑 7：deriveCurrentScene 优先级错位（已 P4 永久修）
原 `deriveCurrentScene` reward 子状态优先于 focus 主状态：focusRunning 进度满 rewardMachine='openingBox' 时 NextStepButton 把当前 scene 误判为 boxCommon → 下一步跳 boxRare 不是 focusCompanion。修：focus 主流程（running/launching/paused/confirmExit）优先；只在 rewarding 状态才让 reward 子状态接管。

## D6 全程 commit 统计（27 commit 总）

| 阶段 | Commit 数 | 时间 |
|---|---|---|
| D6 P1 表情感知 V1.0 | 16 | 早 |
| VPS 部署 | 2 | 下午 |
| D6 P2 真机反馈第 1 轮 | 1 | 晚 |
| D6 P3 真机反馈第 2 轮 | 1 | 晚 |
| **D6 P4-P10 一夜抛光** | **7** | **深夜** |
| 文档收尾 (P1) + (P10) | 4+ | 早+今 |

## D6 P4-P10 新沉淀 memory（4 条）

- [feedback_pwa_sw_skipwaiting_clientsclaim.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/) — PWA SW 客户端缓存陷阱 + skipWaiting/clientsClaim 强更
- [feedback_pointer_events_inheritance_trap.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/) — pointer-events-none 父级继承吞子级 click
- [feedback_z_layer_vs_dom_order.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/) — z 层 + DOM 顺序双因素视觉栈
- [feedback_timer_router_boot_branch.md](../../../.claude/projects/-Users-rayman-chen-mycc/memory/) — timer router 按 bootState 分支走不同 reward 路径

---

**川哥总评（D6 P4-P10）**：一夜抛光，7 commit 把"夜航报告 → 开宝箱 → 状态询问"流程从能跑迭到丝滑。同时把主流程顺序串扰彻底解决，box scene 6-9 移出主线，DebugBar 下拉 / 键盘 6-9 仍可测试。PWA 强更修了 P9 后川哥手机感知不到代码已修的隐形 bug。**小可在公网 demo 上节奏完全可用**，下一步只剩演示场地暗光压测 + 端侧化 P4 长线路线。

