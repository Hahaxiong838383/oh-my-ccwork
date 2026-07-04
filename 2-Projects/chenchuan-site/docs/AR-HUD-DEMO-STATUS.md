# AR HUD Demo · 项目状态 + 技术方案 + 后续 TODO

> 2026-05-22 落盘。本文档是 `/lab/ar-hud-demo` 的项目交接索引，**新人接手只看这一份**。

## 1. 项目定位

访客打开 `/lab/ar-hud-demo` → 授权摄像头 → 用眼动 + 食指捏合体验 AR HUD 座舱：
- PHUD 横向卡片带（6 张：Speed / Energy / Nav / 中央 ETA / Media / VideoPreview）
- AR POI 浮卡（Xiaomi Headquarters / Ocean Blvd）
- 手势捏取拖拽 PHUD 卡互换 + POI 拖入 PHUD

目标用户：招聘者 / 企业高管，5 秒看出「这哥们儿做过多模态产品 × 4 代 HUD」。

卖点：**100% 本地推理 · 零数据上传** · powered by MediaPipe

## 2. 当前状态（2026-05-22）

阶段 1 性能改造完成。**端到端延迟从 ~200ms 砍到 ~60-90ms**，川哥实测「好很多，丝滑和跟手」。

dev 服务在 `http://localhost:3000/lab/ar-hud-demo`，**还未部署到生产**。

## 3. 技术架构

### 推理层（主线程）

- **MediaPipe Tasks Vision 0.10.15** via jsDelivr CDN
  - `FaceLandmarker`：478 landmarks（含眼动 iris）+ 52 blendshape
  - `HandLandmarker`：双手 21 个关键点 + handedness
  - `delegate: 'GPU'`（架构改造后稳定）
- **摄像头 640×480 @ 30fps**（gemini 调研推荐，CPU/GPU 推理快 3x）
- **`requestVideoFrameCallback`** 驱动，metadata.mediaTime 作为 timestamp（与帧绑定，单调）
- **detectForVideo** 同步阻塞，但 GPU delegate 单帧 ~5ms，可接受

### 数据流（store-based，绕开 React state per frame）

```
摄像头帧 (rVFC)
   ↓
MediaPipeStage.detectForVideo (Face + Hand)
   ↓
PermissionGate setState (React)  ── 唯一保留的 React state 路径
   ↓
useInteractionState（写入 store + OneEuroFilter 平滑）
   ↓
InteractionStore (mutable 单例 + subscribe)
   ├→ InteractionCursor (RAF 订阅 + ref.style.transform)
   ├→ DraggableCardWrapper (RAF 订阅 + 拖动跟手)
   ├→ PoiCard (RAF 订阅 + 拖动跟手)
   ├→ DebugPanel (subscribe + 8Hz 节流 setState)
   └→ useDragController (subscribe + 边沿触发 setDragState)
```

### 关键设计

1. **interaction-store.ts** mutable 单例
   - `write(next)` 通知所有 listeners
   - `updateDrag(next)` **静默写**（不广播），避免自订阅死循环
2. **OneEuroFilter 自适应低通**
   - gaze: `(1.5, 0.02, 1.0)` 稍稳
   - pinch: `(3.0, 0.08, 1.0)` 高速跟手
3. **pinch 迟滞判定** 进入 0.05 / 退出 0.10，2D 距离不用 z（z 在 web 不准）
4. **拖拽 hit-test 边沿触发** 只在 pinch start/end 跑 `document.elementsFromPoint`
5. **MediaPipe wasm INFO 日志拦截** patch console.error，过滤 mediapipe 栈降级到 log

## 4. 关键文件

```
src/app/lab/ar-hud-demo/
  page.tsx                 顶层组件，集成所有 hook + UI
  layout.tsx               独立沉浸式 layout（隐藏站点 nav/footer）

src/lib/ar-hud/
  interaction-store.ts     mutable 单例 + subscribe
  use-interaction-state.ts MediaPipe 数据 → store 写入 + OneEuroFilter
  use-drag-controller.ts   拖拽状态机 + edge-triggered hit-test
  one-euro-filter.ts       Casiez 2012 自适应低通
  mediapipe-loader.ts      Lazy load FaceLandmarker + HandLandmarker

src/components/lab/ar-hud-demo/
  PermissionGate.tsx       三态权限流（pending/granted/denied）+ iOS 拦截 + visibilitychange 守护
  MediaPipeStage.tsx       video + canvas + rVFC 推理循环 + pinch 迟滞
  BackgroundVideo.tsx      视频 + CSS 占位双模式
  HudOverlay.tsx           PHUD + POI 调度（轻 wrapper）
  DebugPanel.tsx           自订阅 store + 8Hz 节流（gaze/hands/face 实时）
  interaction/
    InteractionCursor.tsx  gaze 光圈 + 双手 pinch 光点（fixed z-45 RAF）
  phud/
    PhudStrip.tsx          横向布局 + DraggableCardWrapper（RAF 跟手）
    CardFrame.tsx          通用卡片框
    SpeedCard.tsx          68 km/h + D + READY
    EnergyCard.tsx         78% + 312 km + 22°C + 7:45 PM
    NavCard.tsx            ↗ 1.2 km TURN RIGHT + Seaside Blvd
    EtaCard.tsx            ★ 中央 6.3 km + 7:57 PM ETA + 蓝立体箭头
    MediaCard.tsx          ♫ Endless Horizon + Aurora Skies + 控件
    VideoPreviewCard.tsx   缩略图 + 07:15/19:42 + 32°
    types.ts               所有 PHUD 数据类型 + MONO_FONT 常量
  ar-poi/
    ArPoiLayer.tsx         浮卡容器
    PoiCard.tsx            🏢 Xiaomi HQ / 🌊 Ocean Blvd（RAF 拖动跟手）

public/media/ar-hud-demo/
  driver-view-loop.mp4     6.5M，AI 生成黄昏道路第一视角

docs/
  AR-HUD-DEMO-PRINCIPLES.md  范围红线（D1 锚定文档）
  AR-HUD-DEMO-RESEARCH.md    gemini 调研报告（业界参考 + 物理天花板）
  AR-HUD-DEMO-STATUS.md      本文件
```

## 5. Commit 链

### 阶段 1（store-ref 架构改造，2026-05-22 早）

```
ar-hud-d3.2-baseline (tag)  ← 回滚锚点
ebdb2d517  Step 1/5 · InteractionStore + OneEuroFilter（基础设施）
43c8c457b  Step 2+3/5 · 数据流改 store-based + 卡片 ref 跟手
1f5dc507e  fix · updateDrag 改静默写（修死循环 Maximum call stack）
61d645384  Step 4/5 · DebugPanel 自订阅 + 降频 + 删 console.log
4a41f90c9  perf · GPU delegate + pinch 迟滞 + OneEuro 调参
57b7e3f1b  docs · 阶段 1 项目状态总报告（交接索引）
8e59793ab  log · 阶段 1 落盘 session event + task-log
```

### Batch 2 第一档融合改造（2026-05-22 上午，借鉴 cc-AirPlayer + gesture interface + gemini 业界对标）

```
f4fa23328  feat · F2 拖动 swap 预览（bbox 缓存 + hover 让位）
106fc2554  feat · F3+F4 PoiCard 视觉打磨与 transition 对齐
a5f4c2233  feat · G1 Web Audio 触觉反馈（pinch click + swap whoosh）
```

### Batch 3 + 后续优化（2026-05-22 下午，POI 接管导航卡片 + Vision Pro 级 cursor 交互）

```
cab60e12f  feat · POI 数据扩展 + activePoiId 状态机（P1+P2）
754e800ac  feat · NavCard + EtaCard POI 接管视图（P3）
a1608d4e1  feat · PoiStatusChip 顶部芯片（P6，后续 0367950df 已不挂载，组件保留）
18a56d081  fix · 头部追踪光点反向 + useLayoutEffect 替代 useEffect
70619f0a7  feat · POI 拖入 PHUD 区时 NAV+ETA 卡青色高亮预告
b4f794dce  perf · 5 个核心组件 React.memo 阻断 page re-render 传染
1b3fcf9a0  fix · pinch 静止 deadzone-soft 锁定
a24b9eb0a  fix · pinch 后基准点切换（食指尖位移驱动，消除中点√2 噪声+几何跳变）
cb2677e30  fix · POI 路面卡 hide + × pinch-clickable + cursor hard-lock 三段式
0367950df  feat · POI 位置语义化 + 视频循环 reset + 删 chip + 摄像头舒适区映射
5696718c2  feat · PHUD 互换 FLIP 动画（iOS Home Screen 挤压吸附感）
91f930110  fix · 视频 reset 后 POI 位置错乱（inline style RAF 协作陷阱）+ Xiaomi y 30→48
```

回滚命令：
```bash
git reset --hard ar-hud-d3.2-baseline
```

或单步 revert：
```bash
git revert <commit-hash>
```

## 6. 性能演进数据

| 阶段 | 端到端延迟 | 体感 | 说明 |
|------|----------|------|------|
| baseline d3.2 | ~200ms | 卡 | React state per frame 80ms+ + CPU delegate 60ms |
| 死循环修复 | ~150-180ms | 卡 | 主线程被锁死 |
| Step 2+3+4 store-ref | ~120-150ms | 一般 | React render 消除，但仍 CPU delegate |
| Quick wins（GPU + 迟滞 + filter） | **~60-90ms** | 丝滑 | 川哥实测「好很多丝滑」★ |
| **Batch 2 第一档**（视觉马力 + 听觉补偿） | **~60-90ms** | **质变** | 数值未变但 F2 swap 预览 + F3 抓起反馈 + F4 iOS LERP + G1 Web Audio 让"控制感"质变 ★★ |
| **Batch 3 + 后续**（Vision Pro 级 cursor） | **~60-90ms** | **Vision Pro 级** | useLayoutEffect+memo 消除 R 层延迟 / 食指尖位移驱动+hard-lock 三段式让捏合 0 抖动 / FLIP 动画 iOS 桌面感 / 舒适区映射精度+40% ★★★ |
| V2 Worker + ImageBitmap | ~40-60ms | — | 边际收益小，可暂缓 |
| V3 WebGPU + ONNX（季度级） | ~45-60ms | — | 几乎物理天花板 |

## 7. 调研数据来源

- **gemini-3.5-flash 调研**：`docs/AR-HUD-DEMO-RESEARCH.md`
- **codex 架构分析**：`/tmp/codex_ar_hud_analysis_report.md`（未落盘到 docs，cc memory 里有引用）
- **业界参考**：8th Wall（45-60ms）、Apple Vision Pro（visionOS 自渲染）、WebGazer（眼动）

## 8. 后续 TODO（按 ROI 排）

### Batch 2 已完成 ✅

- ~~F2 拖动中 swap 预览（bbox 缓存 + hover 让位）~~ → `f4fa23328`
- ~~F3 抓起视觉反馈增强（双层 shadow + 内描边 + 顶部高光）~~ → `f4fa23328` / `106fc2554`
- ~~F4 LERP 释放动画优化（220ms + iOS cubic-bezier）~~ → `f4fa23328` / `106fc2554`
- ~~G1 Web Audio 触觉反馈（pinch click + swap whoosh，纯合成零依赖）~~ → `a5f4c2233`

### Batch 3 + 后续优化已完成 ✅（2026-05-22 下午）

- ~~POI 接管 NAV+ETA（其他 4 卡保留车辆原始）~~ → `cab60e12f` + `754e800ac`
- ~~POI 位置语义化（Xiaomi y=48 中远景 / Ocean y=56 近景建筑）~~ → `0367950df` + `91f930110`
- ~~POI 拖入 NAV+ETA 卡青色高亮预告~~ → `70619f0a7`
- ~~删除 PoiStatusChip 浮层 + 视频循环 wrap 自动 reset~~ → `0367950df`
- ~~头部追踪光点反向修复（gazeToScreen x 翻转）~~ → `18a56d081`
- ~~useEffect → useLayoutEffect 减少 cursor 滞后~~ → `18a56d081`
- ~~5 个组件 React.memo 阻断 page re-render 传染~~ → `b4f794dce`
- ~~pinch 后基准点切换（食指尖位移驱动）~~ → `a24b9eb0a`
- ~~cursor hard-lock 三段式 deadzone~~ → `1b3fcf9a0` + `cb2677e30`
- ~~× 按钮 pinch-clickable（data-poi-clear + hitTest 拦截，按钮 40×40px）~~ → `cb2677e30`
- ~~POI 路面卡接管后完全 hide（opacity 0 + pointer-events-none）~~ → `cb2677e30`
- ~~摄像头舒适区映射（comfort zone → 屏幕全范围，精度 +40%）~~ → `0367950df`
- ~~PHUD 互换 FLIP 动画（iOS Home Screen 挤压吸附感）~~ → `5696718c2`
- ~~视频 reset 后 POI 位置错乱（inline style + RAF 协作陷阱）~~ → `91f930110`

### Batch 2 第二档（gemini 业界对标推荐，待启动）

| 编号 | 工作 | 工时 | 价值 | 优先级 |
|------|------|------|------|--------|
| **G2** | Ghost Hand 幽灵手自动演示（首屏未授权时半透明手部动画演示一遍拖拽 + "像我这样 →"文字引导） | 2-3h | 解决"50% 不知怎么玩 / 懒授权"流失 | ★★★★★ |
| **G3** | Hover 磁吸（cursor 距卡片 <50px 时卡片向光点 perspective 倾斜） | 1h | 强化"我有反应了"黄金 2 秒视觉占领 | ★★★ |
| **F1+** | "被动伸缩"映射（滑动窗口记录最近 90 帧手部 min/max，自动扩展映射比例；取代 cc 原方案 face 估肩宽） | 1.5h | gemini 砍 cc 原 F1 后的改良替代 | ★★ |

### 上线前必做

| 编号 | 工作 | 工时 | 价值 | 优先级 |
|------|------|------|------|--------|
| D4 | 移动端检测 + 自动播 fallback 录屏 | ~30min | 防移动端尴尬 | ★★★ |
| D5 | 首页 Hero 加 CTA「Try the AR HUD」+ 项目卡内嵌入口 | ~30min | 让访客找得到 demo | ★★★ |
| 部署 | rsync + nginx + 推到 my.chenchuan.cc/lab/ar-hud-demo | ~20min | 真正上线 | ★★★ |
| 文案 | demo 顶部 1 行操作引导（眼动 + 捏合 + 拖拽） | ~15min | 第一次访客不懵 | ★★ |
| V2 Worker | Web Worker + ImageBitmap 零拷贝，砍延迟到 40-60ms | 1-1.5h | 技术 flex，访客感受不到 | ★ |
| 录屏 | 川哥自录 30s demo 视频做 fallback | 川哥 | 移动端 + 慢网兼容 | ★★ |

### 砍掉（不做，gemini 业界对标推翻）

| 编号 | 工作 | 砍掉原因 |
|------|------|---------|
| ~~F5 命中优先级链（含 gaze dwell 300ms 锁定）~~ | webcam gaze 精度灾难（抖动 >100px），dwell 体感像 20 年前残疾人辅助系统。**降级处理**：保留 gaze 光圈视觉装饰（不丢"眼动 + 食指"卖点）但不参与命中判定 |
| ~~F6 pinch confirm 3 帧~~ | 30fps × 3 帧 = 100ms 延迟暴涨 → 总延迟 60-90 → 160-190ms 毁灭性 |
| ~~F7 21 landmark 整体映射~~ | MVP 不需要，复用 cc-AirPlayer v4.10.2 方案重构成本不抵收益 |

## 9. 已知边缘 / 风险

- **iOS Safari**：iOS 16.4+ 支持 MediaPipe，但持续跑双模型会触发 thermal throttling（gemini 调研指出 ~1 分钟后帧率骤降到 <10fps）。建议移动端**直接 fallback 录屏**。
- **首次模型下载**：~13 MB（wasm 3MB + face 3.7MB + hand 7MB）。国内 jsDelivr 速度不一定快，可能要镜像 / 自托管。
- **摄像头权限**：必须 HTTPS 或 localhost。生产环境必须有 LE 证书（chenchuan-site 已有）。
- **autoplay**：浏览器 autoplay policy 不一定让背景视频自动播。已加 onCanPlay/onLoadedData 双保险 play()，但极端环境（preview iframe）仍可能 paused。

## 10. 教训沉淀

详见 cc memory：

**阶段 1（store-ref 架构）**：
- `feedback_realtime_interaction_no_react_state.md` 30fps 闭环不走 React state
- `feedback_mediapipe_web_pitfalls.md` MediaPipe Web 6 大坑
- `feedback_store_subscribe_writeback_loop.md` store + subscribe 死循环
- `feedback_one_euro_filter_for_realtime.md` OneEuroFilter > 固定 α
- `feedback_ar_hud_web_demo_decisions.md` 整体决策汇总

**Batch 2 第一档（融合改造，2026-05-22 上午）**：
- `feedback_web_audio_compensates_visual_latency.md` 听觉反馈补偿视觉延迟（VR/AR 公认 + 30 行 Web Audio 合成 + 调参表）
- `feedback_gemini_industry_benchmark_overrides_cc_intuition.md` cc 直觉打 ★ 排序会高估，gemini 业界对标对抗审能精确反驳
- `feedback_codex_silent_completion_no_commit.md` codex exec 失败模式：完整改完代码但不 commit 不报告（cc 必查 git diff 不信 stdout）

**Batch 3 + 后续（Vision Pro 级 cursor 交互，2026-05-22 下午）**：
- `feedback_react_inline_style_raf_collision.md` RAF 改 inline style + React diff 跳过的隐蔽陷阱，useEffect 顶部 force-reset 铁律
- `feedback_pinch_basepoint_switching.md` 捏合后基准点切换（中点 √2 噪声 + 几何跳变 → 食指尖位移驱动 + hard-lock 三段式）
- `feedback_flip_animation_react_order_swap.md` FLIP 原生实现 React order swap 平滑动画（iOS Home Screen 挤压吸附感）
- `feedback_gesture_ui_pinch_clickable_pattern.md` 手势 UI 按钮设计陷阱（onClick≠pinch）+ data-* hitTest 拦截范式
- `feedback_demo_video_loop_auto_reset.md` 视频循环驱动自动 reset 范式（onTimeUpdate wrap 检测替代手动退出 UI）

**backlog 收官 + cursor 体验臻于完美（2026-05-22 晚）**：
- `feedback_pinch_stabilize_window.md` ★ pinch=true 触发 ≠ 捏合动作完成（迟滞触发后两指仍闭合 ~130ms 真实几何位移）+ 4 帧稳定窗口 + 每帧重置 startCenter 范式（前 5 轮修复都不够的真根因）
- `feedback_cursor_unified_basis_midpoint.md` cursor 基准统一为两指连线中点（hover/pinch 不切换基准）+ 中点对"两指相对调整"的物理免疫
- `feedback_demo_tutorial_min_playback.md` 教学动画最小播放时长保护（防一抬手 unmount 失去引导）

## 11. backlog 收官 + cursor 体验臻于完美（2026-05-22 晚，7 commits）

```
416decf10  feat · D4 移动端 fallback iOS+Android 友好提示
0874ed7a1  feat · D5 首页 Hero CTA + 项目卡内 AR HUD 体验入口
01dcd2009  feat · G2 Ghost Hand 首屏自动演示动画（v1 拖动演示）
8400617c3  feat · G2 引导升级 — 大 CTA 突出授权 + 3 阶段教学对齐实际识别
c3649d7de  fix · Ghost Hand 播完才消失 + pinch anchor 用捏合前帧
33755f29a  fix · 去掉 MediaPipe 加载提示 + cursor 基准统一为中点
ab169329b  fix · pinch 触发稳定窗口 — 4 帧 cursor 锁定消除捏合跳跃 ★ 真根因
```

**cursor 跳跃问题 5 轮优化才找到真根因**：信号源 / 锚点 / 滤波三层都做对了，但 pinch=true 触发判定本身的语义错（不等于动作完成）。最终用 4 帧稳定窗口（PINCH_STABILIZE_FRAMES=4，~130ms）+ 每帧重置 startCenter 彻底解决。

## 12. 公网上线 + 部署事故救援（2026-05-25，7 commits）

```
da065e6dc  feat · PHUD 实时 swap — 借鉴 gesture interface 手机桌面 APP 范式
e6be4dfcd  fix · PHUD 布局整齐（CardFrame min-w）+ swap 位置补偿改 microtask 真实测量
c4cfc9c9c  fix · PHUD 捏取后卡片中心锁定光标（startPoint = selfRect 中心）
2c5b6e582  feat · contact 页微信二维码（next/image 240px + .gitignore 绕开 *.png 规则）
ed0fbd71b  feat · Hero CTA 改"体验纯 Web 手势" + 微信描述改 text-white/90 浅色
37e4a8d3f  feat · ProjectGrid AR HUD 入口改 + Desktop Only 标签 + 技术深度描述
5b90a7c17  fix · MediaPipe 资源自托管解决公网识别失效（jsdelivr+googleapis 国内不可达）
```

**部署 3 个关键修复**：

| 问题 | 根因 | 修复 |
|---|---|---|
| 公网背景视频 404 | nginx `^~ /media/` alias 走 `/var/www/.../media/`，rsync 同步到 `public/media/` 路径不匹配 | ssh `cp public/media/ar-hud-demo/*.mp4 → media/ar-hud-demo/` |
| 公网识别功能没有 | mediapipe-loader 用 cdn.jsdelivr.net wasm + storage.googleapis.com models 国内不可达 | 自托管 wasm + model 到 `public/mediapipe/` (~44MB)，改 loader URL 用本地路径 |
| rsync 误覆盖生产 SQLite | memory rsync 命令未 `--exclude='data/'`，本地 dev db (8 行) 覆盖 VPS 生产 db (53 行) | **/proc/PID/fd 抢救神技**：daemon 还持有旧 inode → cp /proc/336810/fd/43 → atomic 替换 → 数据零丢失 |

**3 个新 cc memory feedback**：
- `feedback_mediapipe_cdn_self_host.md` ★ MediaPipe Web demo 国内部署必须自托管
- `feedback_rsync_db_overwrite_proc_fd_rescue.md` ★★ Linux /proc/PID/fd 抢救已被 rsync 覆盖的 SQLite
- `feedback_chenchuan_site_media_dual_path.md` dev/prod 媒体路径不同的部署陷阱

**当前公网状态（2026-05-25）**：
- ✅ https://my.chenchuan.cc/lab/ar-hud-demo 全功能可用（背景视频 + MediaPipe 识别 + 全 Vision Pro 级 cursor 交互）
- ✅ https://my.chenchuan.cc/contact 微信二维码 + 浅色描述清晰可见
- ✅ analytics DB 持续累积访客数据（部署事故 0 损失）

**AR HUD demo 全程进度**：阶段 1 + Batch 2 + Batch 3 + backlog 收官 + 公网上线 = **全部完成** 🎉
