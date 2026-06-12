# D4 美术化全线总结（2026-05-15 ~ 2026-05-16）

> 完工时间：2026-05-16
> 主任务：focusRunning / focusCompanion 美术化（10 个 stage）+ 静思/出航/宝箱/生态缸资源替换
> 总提交：13 个 commit（baseline + P0~P9.7）
> 模式：Team Mode（CC 主线 + Codex 写码 + Gemini Review）

---

## 一、Commit 时间线

| Commit | 主题 | 类型 |
|---|---|---|
| `8174b4b2` | 跳关条 focusCompanion + focusMode store 字段 | baseline |
| `06fbfca3` | GPT 排查 4 项消除（env/dead script/voice-client race/e2e）| pre-D4 |
| `b18cb5a1` | playwright + e2e 接 aria-label | pre-D4 |
| **`c07959cf`** | **D4 P0 决策记录档 + Phase 拆分 + 回滚锚点** | docs |
| **`f6868104`** | **D4 P1 基建（store + Screen 路由 + FocusRunning/Companion + DebugBar 调试控件）** | feat |
| **`a4704912`** | **D4 P2 动效（crossfade hook + 4 stage CSS keyframe + 伪旋转环）** | feat |
| **`9f207bd6`** | **D4 P3 起航过渡（launching 双图层 + 预加载 + sayDirect TTS）** | feat |
| **`abc5bd38`** | **D4 P4 reward 交接（rewarding state + dispatchRewardEvent + 边沿检测）** | feat |
| **`b8806fa1`** | **D4 P5 StatusBar 跨场景 + z-index 75 修复遮挡** | fix |
| **`33f69377`** | **D4 P6 静思 4 张图替换** | feat |
| **`906128ea`** | **D4 P7 出航 7 张图替换（按视觉用途映射）** | feat |
| **`cc0f09a8`** | **D4 P8 宝箱 emoji → PNG（+ legendary 圆环修复）** | feat |
| **`e71494ee`** | **D4 P9 生态缸 4 mp4 升级演示（EcoUnlock 内嵌 video）** | feat |
| **`e015d24a`** | **D4 P9.5 视频全屏 800×480** | fix |
| **`c8a7cdfe`** | **D4 P9.6 4 等级按钮在 ecoUnlock 中可见** | fix |
| **`c639c9e5`** | **D4 P9.7 视频开声音播放** | fix |

---

## 二、能力增量

### 1. focus 场景体系（P1~P4）

- **新增字段**：`focusProgress (0-100) / focusStage / focusStartedAt / focusSpeed`
- **新增 state**：focus-machine `rewarding`（progress 满 → 自动开宝箱）
- **新增事件**：`FOCUS_PROGRESS_TICK / FOCUS_REWARD_READY / REWARD_FLOW_DONE`
- **新增 effect type**：`tickFocusProgress / setFocusStartedAt / dispatchRewardEvent`
- **新增 hook**：`useFocusProgressTick`（定时器） / `useStageCrossfade`（双图 crossfade + 伪旋转） / `useFocusArtPreload`（资源预加载）
- **新增 scene**：`FocusRunning.tsx` / `FocusCompanion.tsx`（4 stage + launching + rewarding 视觉）
- **DebugBar 控件**：速度滑块 0.5-20× / 进度起点输入框 / 一键满进度 / 演示出航过渡 / 演示静思过渡

### 2. 资源命名规范化

| 类别 | 路径 | 数量 | 命名 |
|---|---|---|---|
| 出航美术 | `public/art/focus-running/` | 8 PNG | `01-launching ~ 08-handoff` |
| 静思美术 | `public/art/focus-companion/` | 4 PNG | `01-locked ~ 04-full` |
| 宝箱 PNG | `public/art/box/` | 4 PNG | `1-common ~ 4-legendary` |
| 生态缸视频 | `public/art/eco/` | 4 MP4 | `1.mp4 ~ 4.mp4` |

**规范**：数字前缀（顺序）+ 英文等级语义（无 URL encoding 风险）+ 川哥源文件保留原名在 `本机 Documents/`，cc cp 时统一改名。

### 3. 跨场景共享 UI

StatusBar 从 MainScreen 提升到 Screen.tsx 层级，所有 scene（FocusRunning/Companion/MainScreen）共享。z-layer-feedback `50 → 75` 浮在 OpenBox/Welcome (mask 70) 上方。

### 4. 视频集成（P9 系列）

- EcoUnlock 内嵌 video 全屏（800×480 顶满 + 长度裁切）
- `key={ecoLevel}` 强制 remount 重播
- `autoplay loop playsInline preload=auto` + `onCanPlay` 兜底 unmute（iOS 拦截 → 退回 muted）
- DebugBar 4 等级按钮持续显示（ecoUnlock 中也可切）

---

## 三、踩坑与经验（沉淀到 memory + skill）

### A. 跨资源类型的视觉栈冲突

**P8 emoji → img 翻车**：legendary 宝箱原 emoji `📦` 配 `scale 3.5× + brightness 1.5` 圆环显示"爆金"。切换到不透明 PNG 后金色滤镜把整张图染色完全遮死。

教训：**换素材类型必须重审视觉栈**。emoji/字符 vs 不透明图，filter 行为完全不同。修复：撤销特殊化 + 加 z-10 保险。

### B. 子目录 codex 跑时不能依赖父仓 docs/rules

D4 全程 codex prompt 显式标注"项目是 mycc 仓子目录，git 根 主仓根，不要访问父仓 docs/rules，本项目自带 docs/"。这一条避免了 codex 跑歪。

### C. 路由分流后子组件丢失

P1 加 Screen 路由分流到 FocusRunning/Companion，**原本在 MainScreen 内的 StatusBar 完全消失了**，川哥真机看不到字幕。修复：StatusBar 提升到 Screen 层级。

教训：**新增 scene 分流时必须检查"上一级 scene 提供的共享 UI 是否还在"**。

### D. gemini review 真发现深层 bug

Gemini R1 在 P5 修复后发现 z-index 50 < OpenBox 70 会被遮挡（CC 没意识到的真问题）。Gemini R2 又在 close() 同步清 pendingWs 后发现 `connectPromise` 漏清的死链问题。

教训：**简单改动也派 gemini review**，flash 模型成本低但抓 bug 准。

### E. 资源命名 vs 文件名顺序

P7 川哥发的"出航1.png"是 transition 帧、"出航2.png"是 launching 主图，**文件名 1/2 顺序与代码语义反**。按文件名严格 1:1 映射会让 demo 视觉违和。

教训：**按视觉用途映射（cc 看图判断）而不是文件名数字**。每次决策记入 commit message。

### F. e2e PASS ≠ 视觉正确

E2E 只测 console.error / 404。**视觉正确性必须看截图**。今天每个 P 都跑 `node apps/web/scripts/p[x]-mini-test.mjs` 截图，cc 读图判断。

### G. iOS Safari 视频自动播放硬要求

`autoplay loop muted playsInline preload=auto` 全齐才能在 iOS Safari 自动播。后续 unmute 需要 user activation（用户点击过任意按钮）。**onCanPlay 兜底**：先尝试 unmute play()，被拦截 → 退回 muted=true 重试，避免"完全不播放"死锁。

---

## 四、后续 TODO

### P10 出航视觉链路修复（川哥说"最后一起修"）

**问题**：当前出航 7 张 PNG 按视觉用途映射，但川哥要求按"出航1-7"最新命名整理。同时 04/05 视觉位置不同导致伪旋转环 crossfade "穿帮"。

**待办**：
- [ ] 重命名 public/art/focus-running/ 文件为 `出航1.png ~ 出航7.png`（保留语义映射逻辑，仅文件名变化）
- [ ] 或：在 STAGE_IMAGE_MAP 中按川哥新命名引用
- [ ] 评估 04/05 伪旋转环 crossfade 体验，必要时关闭 alternateEnabled 或重新映射

### P11 Welcome 字幕技术债（P5 留下）

Welcome 场景的"你好，指挥官！"字幕是 Welcome 组件自渲染（baked 在视觉里），不依赖 StatusBar。导致 mainScreen mini test 注入 subtitle 看不到。**P5 暂不动**，等真机演示有需求再统一。

### P12 真机 D4 演练

- [ ] iOS Safari HTTPS + AudioContext 解锁链验证
- [ ] mkcert 真证书替换 vite-plugin-basic-ssl（让权限持久化）
- [ ] 麦克风预授权（SetupGuide「完成配网」按钮 onClick 同步栈内 getUserMedia）
- [ ] 微信内置浏览器拦截层

### P13 性能优化

- [ ] 4 个生态缸 mp4 总 6.8MB，按需懒加载（当前 useFocusArtPreload 仅预加载 PNG）
- [ ] PWA precache 现在 24 entries / 7.2 MB，评估首屏阻塞
- [ ] 真机 60fps 验证（4 stage CSS keyframe 在 iPhone 12 Safari 跑测）

### P14 出航/静思 TTS 唇形同步

当前 launching TTS "坐稳啦，我们要出发咯！" / "慢慢来，深呼吸放松一下。" 是固定文案。后续可接 LLM 动态生成（根据用户最近活动）。

---

## 五、Team Mode 协作复盘

**统计**：
- Codex 调用 6 次（P1/P2/P3/P4/P5/P9），全部 PASS（其中 1 次发现 typo cc 手修）
- Gemini Review 8 轮（P1×1 / P2×1 / P3×1 / P4×1 / P5×2 / P9×1 / P5 z-index ×1），8 次 APPROVE，2 次 NEEDS_FIX 后 CC 接纳改 + 二审通过
- CC 写代码 4 次（P5 z-index、P7/P8/P9 资源 cp、P9.5/P9.6/P9.7 视频 fix）—— 简单微调 cc 直接做更快
- E2E + mini test 跑 ~15 次，0 errors / 0 404s 持续

**关键判断**：
- "team 模式但 cc 自主做 micro fix" 是高效平衡。codex 跑成本（5-15 分钟）vs cc 直接做（30 秒-2 分钟），改动 ≤2 文件 + ≤30 行用 cc。
- "gemini review 即使 cc 直接做也要派" —— 1-3 分钟成本，抓深层 bug 能力强（z-index 遮挡、stale onclose、握手期死锁等）。

**踩坑**：
- 多 codex 并行可能 build 撞 EJSONPARSE 误报（codex A 改 package.json 时 codex B 跑 build）
- gemini 3-pro 限流频繁，flash-preview 模型名带 -preview 后缀才能调通
- gemini workspace 限制无法读 cwd 外文件，看图任务需 cp 到 cwd

---

## 六、回滚方案

每个 Phase 独立 commit，回滚粒度精细：
- 撤销单 Phase：`git revert <P[N] commit>`
- 回到 D4 前：`git reset --hard b18cb5a1d`（baseline，慎用）
- 见 `docs/D4-focus-art-decisions.md` 完整决策记录档

---

署名：cc（Claude）| 2026-05-16
