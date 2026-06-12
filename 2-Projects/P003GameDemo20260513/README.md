# P003 K1 Game Demo

> 儿童陪伴机器人 K1 web 模拟器 · 800×480 像素锁定 · 6 天交付

---

## 📌 项目一眼看清（AI 接手者必读）

**🎯 是什么**：FUTURUS 自研儿童陪伴机器人 **K1** 的 web demo 模拟器。设备形态是飞船舷窗造型 + 一只拟人化星灵小可。Demo 目标是给投资人 / 合作方 / 现场演示用，让他们 **5 分钟体验完 K1 主要能力**：开机欢迎 → 夜航报告 → 选模式（出航/静思）→ 4 阶段专注 → 开宝箱 → 选择继续/返舱 → 关盖告别。

**🌐 现状（V1.0）**：[https://<demo域名>/](https://<demo域名>/)（公网 HTTPS，HK 阿里云 <HK-VPS> 部署），打开手机扫即可演示。

**🏗 技术栈**：
- 前端 React 18 + Vite 5 + TypeScript strict + Tailwind + Zustand + framer-motion + CSS container queries (cqw/cqh)
- 后端 Hono + Node `ws` + tsx + ESM（端口 :3001）
- 三段语音链路：ASR 火山 SAUC v3 + LLM Gemini via 内部代理网关（`gemini-3.1-flash-lite-preview`）+ TTS Doubao 2.0 双向流
- **D6 新增**表情感知：Gemini Vision (`gemini-2.5-flash` + `thinking_budget=0`) + A' 架构（scene 切换瞬间预抓拍 + 5s 后台兜底）
- 部署：阿里云 HK + nginx + systemd + Let's Encrypt

**🎨 4 个绝对目标**（[`docs/DEMO-PRINCIPLES.md`](docs/DEMO-PRINCIPLES.md)）：
1. 手机竖屏外壳 + 800×480 像素锁定 5:3 画布
2. 小可 AI 实时语音对话 ≤2.5s 端到端
3. 4.5 天交付（实际 6 天，含 D5/D6 抛光）
4. **demo 第一原则**：砍 9 层 / XState / MSW / Dexie，纯 CSS + cqw/cqh

**💎 设计原则**：
- 演示节奏 > 工程完美：宁可写死 timer 别引入状态机层级
- 字幕 / TTS / 视觉**严同步**：见 `feedback_subtitle_tts_strict_sync_pattern`
- 摄像头隐私：server 即用即抛不存图（demo 可云，商业化必转端侧）
- 真机驱动迭代：川哥手机反馈 → cc 主线快速修 → rsync VPS → 公网验证

**🗺 后续路线（D6 完工之后）**：

| P | 项 | 触发条件 |
|---|---|---|
| P1 | 暗光 / 逆光 / 侧光压测 + confidence 分布统计 | 演示场地确定后 |
| P2 | 多帧投票（最近 3 帧滑动窗口取 mode） | 命中率不稳时 |
| P2 | "看到你啦" 首次抓拍 trigger / "我看不到你呢" 0.3 概率回退语 | 视演示场景 |
| P3 | DebugBar 5 flag 行清理（demo 上线前隐藏） | 投资人 demo 前 |
| P4 商业化 | 端侧 MediaPipe Tasks Vision 替换云端 Gemini | 合规 + 零延迟，产品化路线 |

**🧭 关键导航文档**：
- [`docs/D1-log.md`](docs/D1-log.md) ~ [`docs/D6-log.md`](docs/D6-log.md) 6 天迭代完整复盘
- [`docs/D6-vision-expression-plan.md`](docs/D6-vision-expression-plan.md) — D6 表情感知 V0.2 规划（codex + gemini 双评审整合）
- [`docs/DEMO-PRINCIPLES.md`](docs/DEMO-PRINCIPLES.md) — 4 绝对目标 + 范围裁剪表
- [`docs/00-product-spec.md`](docs/00-product-spec.md) — 产品规格 + 术语表
- [`docs/05-server-contracts.md`](docs/05-server-contracts.md) — C/S 接口契约（ASR/LLM/TTS/Vision）
- [`docs/TECH-DEBT.md`](docs/TECH-DEBT.md) — 技术债清单（demo→优化阶段路线图）

---

## 🚀 进展速览（2026-05-18 · **D6 V1.0 完工**）

**当前 V1.0** · D1→D6 共 6 天 / 96+ commits / 表情感知打通

```
✅ D1 V0.4    框架 + 9 组件 + 凭据探针
✅ D2 V0.6    整体竖屏 + ASR/LLM/TTS 三段闭环 + 真机通
✅ D3 V0.7    OpenBox 4 级 + EcoUnlock + Farewell + 4 大调试链修复
✅ D3.5       配网美术化 + 视频过渡 + Welcome 写实图 + TTS sayDirect 通道
✅ D4 V0.8    全场景美术化（12 PNG + 4 MP4）+ focus 4 stage 链路
✅ D5 V0.9    25 commits · 字幕 TTS 严同步 + 专注流程闭环 + debug 工具集
✅ D6 V1.0    16 commits · 表情感知 A' 架构 + Gemini Vision + 12 标签 + 1.6s 延迟
✅ D6 P2-P10  11 commits · VPS 部署 + 真机迭代 6 轮抛光（夜航 UX + 主流程顺序 + PWA 强更）
```

### D6 P4-P10 一夜抛光（7 commit）

| Phase | 触发 / 真凶 | 修 |
|---|---|---|
| P4 `4b403cf9c` | 夜航过小 + 下一步跳错关 | 1.4× 放大 + 加收取按钮 + deriveCurrentScene focus 优先 |
| P5 `882d038f9` | 底部"新解锁"溢出 | 信纸 bottom 22→6% + 按钮挪右上 |
| P6 `39769a08a` | 按钮过小 + 没开箱 | 按钮 1.5× + onClick 触发 dispatchReward OPEN_BOX |
| P7 `7a1dcb6f6` | 开箱没视觉 | NightReport z=80 盖 OpenBox z=70 修（P9 撤回） |
| P8 `6660a028a` | 按钮没反应 | **真凶**：P6 漏抄 pointer-events-auto，父 pointer-events-none 吞 click |
| P9 `0070a943c` | 切换太快 | onClick 只 dispatchReward + OpenBox 升 z 平级 + timer router rewardShown 加 bootState 分支 |
| P10 `13860e6b1` | 川哥手机仍报老 bug | **真凶**：PWA SW 缓存旧 JS。修 workbox skipWaiting+clientsClaim + SCENE_ORDER 删 box*(6789) |

### D6 表情感知打通（按系统分组）

| 系统 | Commit 范围 | 关键改动 |
|---|---|---|
| **规划评审** | `ad2a7ecc9` → `a239b335f` | V0.1 规划 + V0.9 回滚 tag + codex/gemini 双评审 NEEDS_FIX/NEEDS_TWEAK 整合 V0.2 |
| **A' 架构实施** | `ef8460db4` | team 并行 codex A 前端 + codex B 后端 + cc 主线契约 Gate（581 行 / 11 文件）|
| **真机踩坑链** | `ddfb5f2f0` → `5862d7609` | vite proxy /api / catch lastSkip / timeout 1.5→5s / 离屏 video 1×1→160×120 |
| **后端踩坑** | `62e6f3aa1` → `b9b405fcb` | facingMode user / prompt 去儿童 / Gemini raw 日志 |
| **真凶逮捕 #1** | `925ced525` → `d03f0f8bf` | Gemini 3 thinking reasoning_tokens 吃 max_tokens → 4096 → 65535 |
| **命中率优化** | `1270a07ba` | prompt 偏向找表情 + 阈值 0.6 + jumpToScene force snap |
| **🔥 速度优化** | `20fe65689` | **vision 6s→1.6-2.1s（-70%）**：换 gemini-2.5-flash + thinking_budget=0 + 图压 160×120 |
| **人设感** | `69409fd2c` | neutral 加 "嗯，" 前缀（A 方案）|
| **表情扩谱** | `96eb822aa` | V2 扩到 13 标签（含 sad/excited/focused/thinking 等）|
| **真凶逮捕 #2** | `14ed2738d` | V3 删 neutral + 修 isExpressionLabel 旧白名单 bug（V2 漏改）|

### D6 三大踩坑（沉淀给后续）

1. **Gemini 3/2.5 thinking 模型 reasoning_tokens 隐式吃 max_tokens** → response.content 字段直接缺失。修：`extra_body.google.thinking_config.thinking_budget: 0` · `feedback`
2. **多路 codex 后类型守卫 isXxx 函数漏同步**：扩 union 时 `value === 'happy' || ...` 这种硬编码 tsc 抓不到，必须 grep 6 处消费方 · `feedback`
3. **iOS Safari getUserMedia 三件套**：facingMode 默认后置 / 1×1 video 停帧解码 / 手势栈强制 · `feedback`

### D6 演示流程（V1.0）

```
手机 https://<内网IP>:5173/ → 完成配网（触发摄像头授权）
  ↓ 抓拍 → Gemini Vision (1.6-2.1s) → currentRef.expr 更新
  ↓ 跳关 1: Welcome（小可："看你这么期待，你好，指挥官！..."）
  ↓ 跳关 2-11: 全程带 12 种表情前缀（happy/sad/curious/focused/thinking/...）
debug: DebugBar 表情行 expr+conf+age + 5 flag 诊断 + 手动 snap + 清旗 + 预览开关
```

### D6 后续 TODO

| P | 项 |
|---|---|
| P1 | 真机现场暗光 / 逆光 / 侧光压测（演示场地光线复杂）|
| P1 | confidence 分布统计（实测 12 标签命中比例）|
| P2 | 多帧投票（最近 3 帧滑动窗口取 mode）防瞬时误判 |
| P2 | "看到你啦" 首次抓拍成功 trigger（V0.2 §9.2 没实现）|
| P3 | 摄像头拒绝场景 0.3 概率说"我看不到你呢"（V0.2 §9.3 没实现）|
| P3 | DebugBar 5 flag 行清理（demo 上线前隐藏）|
| P4 商业化 | 端侧 MediaPipe Tasks Vision 替换云端 Gemini（合规 + 零延迟）|

详见 [`docs/D6-log.md`](docs/D6-log.md) 完整复盘（16 commit 时间线 + 真凶诊断 + 经验沉淀）。

---

### D5 24 轮迭代（按系统分组）

| 系统 | Phase | 关键改动 |
|---|---|---|
| 字幕条统一 | P1-P4 | StatusBar 胶囊 + 字幕统一走 z-90 层 + 修字幕全消失 + 磨砂方块贴底 |
| 取消自动推进 | P5 | 删 demo autoTimer（要 jumpToScene/用户触发）+ NightReport 去信封壳 |
| **字幕 TTS 集中化** | **P6-P7** | applyEffects 默认非空 → sayDirect；删 5 处 scene-level sayDirect；App mount prewarm ws 修首次卡顿 |
| 进度条 + 切图 | P8-P14 | focusStageDurationMs 控制 4 阶段时长 + FocusProgressBar 美术槽对齐 + 修 useStageCrossfade cleanup race + cqh 单位 fallback 陷阱 |
| 返舱/继续闭环 | P15-P18 | EXIT_CONFIRM 跳 welcome / 继续按 focusMode 选出航or静思 / 静思 launching 时长独立 |
| **字幕 TTS 严同步** | **P19-P22** | onAudioStart at flushMp3Buffer 内 src.start() / 打字机 5 字/秒 / 跨句 fade-up / 消失公式 240ms/字 |
| 文案差异化 | P23 | 静思后说"继续静思 还是 返舱"（出航保持不变）|
| **宝箱手动触发** | **P24** | 进度满后透明覆盖按钮叠在美术"收获奖励" 用户点击触发 |

### 沉淀的 3 大工程范式
1. **字幕 + TTS 严同步**：出现等 `src.start()` AudioContext clock / 推进用打字机字速 / 消失公式匹配字速 + buffer · `feedback_subtitle_tts_strict_sync_pattern.md`
2. **useEffect cleanup race**：deps 含自 set state → cleanup 取消 raf → setOpacity 永远卡 0 · `feedback_useeffect_cleanup_cancels_raf_timer.md`
3. **cq 单位 fallback 陷阱**：加 containerType 会全局缩 cqh 元素 · `feedback_cq_unit_fallback_pitfall.md`

### 真机演示流程（V0.9）

```
手机 https://<内网IP>:5173/ → 完成配网
  ↓ 跳关 1: 开机欢迎 (字幕+TTS 同步)
  ↓ 跳关 2: 夜航报告 (1-4 随机宝箱 PNG)
  ↓ 跳关 3: 状态询问 → 选出航/静思
  ↓ 出航 4.5s 飞船过渡 / 静思 2.5s 单图过渡
  ↓ 4 阶段切图 + 进度条 16s 满
  ↓ 手动点击"收获奖励" → 随机宝箱品质 → 字幕+TTS 同步
  ↓ 询问"继续出航/静思 还是 返舱?"
     ├ 继续 → 回出航/静思
     └ 返舱 → 太棒了 +10 → 回欢迎

debug: 左下紫色徽章实时显示场景编号 + focus state
       K1 右侧"下一步"循环跳关
```

### 后续 TODO（按优先级）

| P | 项 |
|---|---|
| P1 | 真机 D5 演练（iOS Safari HTTPS + mkcert + 字幕同步实测）|
| P1 | sayDirect 路径下 onAudioStart 完整接通（让 boot 字幕也走 voice-client cb 同步）|
| P2 | RewardClaimButton 位置/尺寸真机微调（用 % 估的）|
| P2 | FocusProgressBar 不同 stage 美术槽位差异校准 |
| P3 | 清理 stale 注释 + 删 `focusSpeed` store 字段（已无消费方）|
| P3 | Welcome scene STARS 星点装饰可外提复用组件 |

详见 [`docs/D5-log.md`](docs/D5-log.md) 完整复盘（25 commit 时间线 + 3 大踩坑根因 + 工程范式沉淀）。

## 技术栈

- **前端**：React 18 + Vite 5 + TypeScript strict + Tailwind + Zustand + framer-motion + CSS container query units (cqw/cqh)
- **后端**：Hono + Node `ws` + tsx + ESM
- **三段语音链路**：
  - **ASR**：火山大模型 sauc v3（官方 v3 双向流端点）
  - **LLM**：gemini-3.1-flash-lite-preview via 内部代理网关（TTFT 0.80s，max_tokens 65535）
  - **TTS**：Doubao-TTS 2.0 双向流（音色 `zh_female_tianmeixiaoyuan_moon_bigtts` 甜美小源）
- **新增 TTS sayDirect 通道**：绕过 ASR+LLM 直接 `{ type:'tts.say', text }`，用于开机欢迎语等无 ASR 触发场景

## 文档导航

| 文档 | 作用 |
|---|---|
| [`DEMO-PRINCIPLES.md`](docs/DEMO-PRINCIPLES.md) | **目标锚定（必读）** —— 4 个绝对目标 + 范围裁剪表 |
| [`D1-log.md`](docs/D1-log.md) | D1 V0.1-V0.4：框架 + 9 组件 + 凭据探针 |
| [`D2-log.md`](docs/D2-log.md) | D2 V0.6：B+C 方案 + 整体竖屏 + 三段端到端 + 9 真机 bug 复盘 |
| [`D3-log.md`](docs/D3-log.md) | D3 V0.7：三场景 + 4 大调试链路 + 团队协作产出 |
| [`D3.5-log.md`](docs/D3.5-log.md) | D3.5：美术化 + Welcome 写实图 + TTS sayDirect + 5 大踩坑 |
| [`D4-focus-art-decisions.md`](docs/D4-focus-art-decisions.md) | D4 决策记录档（P0~P9.7 完整 Phase 拆分 + 回滚锚点）|
| [`D4-art-final-summary.md`](docs/D4-art-final-summary.md) | D4 最终总结（commit 时间线 + 能力增量 + 踩坑沉淀）|
| [`D5-log.md`](docs/D5-log.md) | **D5 完整复盘（P1-P24 时间线 + 3 大踩坑根因 + 工程范式沉淀）** |
| [`TECH-DEBT.md`](docs/TECH-DEBT.md) | 技术债清单（demo→优化阶段路线图）|
| [`00-product-spec.md`](docs/00-product-spec.md) | 产品规格 + 术语表（V1.0 参考） |
| [`05-server-contracts.md`](docs/05-server-contracts.md) | C/S 接口契约（含新增 tts.say） |

## 启动

```bash
# 后端（apps/server）：HTTPS 端口 3001
cd apps/server && npm start

# 前端（apps/web）：HTTPS dev server 5173 + WSS vite proxy
cd apps/web && npm run dev

# 手机扫码：https://<本机 IP>:5173/
```

凭据放 `apps/server/.env.local`（chmod 600，gitignored）。

## 4 个绝对目标（达成情况）

1. ✅ 手机竖屏外壳 + 800×480 像素锁定 5:3 画布
2. ✅ 小可 AI 实时语音对话：端到端 ~2.4s（达标 ≤2.5s）
3. ✅ 4.5 天交付（D1+D2+D3+D3.5+D4 已完成，D5 收尾）
4. ✅ demo 第一原则，砍 9 层 / XState / MSW / Dexie，纯 CSS + cqw/cqh
5. ✅ **D4 新增**：全场景美术化（12 PNG + 4 MP4）+ focusRunning/Companion 完整链路（launching → 4 stage → reward 交接）

详见 [`docs/DEMO-PRINCIPLES.md`](docs/DEMO-PRINCIPLES.md)。

## 验收脚本（playwright + chrome）

```bash
# 完整 7 段 E2E（含 11 场景跳关 + 11 键盘 + C2 状态机 + C4 box×4 + farewell + voice）
node apps/web/scripts/e2e-flow-test.mjs

# mini test：P4 reward 自动交接链路
node apps/web/scripts/p4-reward-handoff-test.mjs

# mini test：P5 字幕在 3 场景显示
node apps/web/scripts/p5-subtitle-test.mjs

# mini test：P9 生态缸 4 等级 mp4 切换
node apps/web/scripts/p9-eco-levels-test.mjs
```

所有截图归档到 `.scratch/{e2e,p4,p5,p9}-screenshots/`。
