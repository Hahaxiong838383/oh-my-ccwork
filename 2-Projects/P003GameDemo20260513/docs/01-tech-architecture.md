# 01 · 技术架构决策

> 2026-05-13 · cc · V0.1

## 目标约束

- Web 端，移动浏览器优先（iOS Safari + Android Chrome）
- 手机扫码 5 秒内能看到第一帧
- V1.0 → V3.0 演进时不需要推翻重做
- 美术资源可以"先占位、后替换"
- 单人/双人开发速度优先

## 技术栈决策

### 选定栈

| 层 | 选择 | 备选 | 理由 |
|---|---|---|---|
| 构建 | **Vite 5** | Webpack/Next.js | 热更快、ESM 原生、移动调试方便 |
| 语言 | **TypeScript 5** | JavaScript | 系统多，类型保住核心循环不写错 |
| UI 框架 | **React 18** | Vue/Svelte | 生态最大，团队招人方便 |
| 渲染引擎 | **PixiJS v8** | Phaser / Three.js / CSS | 2D 硬件加速、帧动画/Spine 友好、体积小（gzip ~150KB） |
| 样式 | **Tailwind CSS** | CSS Modules / styled-components | 移动适配快，类原子化 |
| 状态 | **Zustand** | Redux / Jotai | API 极简，与 PixiJS 解耦 |
| 持久化 | **Dexie (IndexedDB)** | localStorage | localStorage 容量小、同步阻塞；Dexie 撑得起藏品库 |
| 动效 (UI) | **Framer Motion** | CSS transitions | 入退场、手势、layout animation 一把梭 |
| 动效 (游戏) | **PixiJS + GSAP** | 仅 PixiJS | GSAP 处理复杂时间轴 |
| 语音 | **Web Speech API** | 云端 STT | 浏览器原生，demo 阶段够用；硬件版换 Whisper/MiniMax |
| 打包/安装 | **vite-plugin-pwa** | 原生 | PWA = "添加到主屏幕"，零原生工程师成本 |
| 部署 | **Vercel** | Cloudflare Pages / 自家 VPS | git push 自动部署 + 国内可访问性可接受 |

### 不选的理由

- **Phaser 3**：scene 系统重，V1.0 没有物理需求；如果后续 V2.0+ 沙盒建造确实需要，PixiJS 也能加 matter.js
- **Three.js**：3D 显著拉高资源/性能门槛，生态缸 2D 已经足够动人
- **Next.js**：服务端渲染对纯客户端游戏没价值，反而拖慢冷启动
- **Tauri/Capacitor 包 App**：先 PWA 验证，包壳是 V1.5+ 的事

## 架构分层

```
┌──────────────────────────────────────────┐
│  React UI 层（scenes / ui / Tailwind）    │  ← 引导、卡片、设置、按钮
├──────────────────────────────────────────┤
│  Systems 层（业务逻辑，纯 TS）             │  ← 计时/宝箱/离线/语音
│  - focus-timer   - treasure-box           │
│  - offline-reward - voice                 │
├──────────────────────────────────────────┤
│  Store 层（Zustand）                      │  ← 跨层共享状态
├──────────────────────────────────────────┤
│  Game 层（PixiJS）                        │  ← 生态缸/K1/特效
│  - ecosystem    - k1    - effects         │
├──────────────────────────────────────────┤
│  Storage 层（Dexie / IndexedDB）          │  ← 持久化
└──────────────────────────────────────────┘
```

**依赖方向**：UI → Systems → Store → Game / Storage。Game 层只读 Store，不反向调 UI。

## UI 层级规范（产品框架要求落地）

参考产品文档"UI界面层级规范"：

```
z-index 0      : Pixi Canvas（生态缸背景 + K1）
z-index 100    : 静态 UI（顶栏资源、今日目标卡片）
z-index 1000   : 动态反馈（轻提示、Toast）
z-index 5000   : 动画层（开箱、离线收益弹窗）
z-index 9999   : 遮罩 / Modal（设置、确认框）
```

**多事件并发优先级**（同时来 N 个反馈时的队列）：
1. 离线收益弹窗（最高，开盖必看）
2. 今日目标提醒
3. 开箱动画
4. 普通 Toast

由 `store/feedback-queue.ts` 单例队列调度。

## 文件组织约束

引用 [global coding-style](../../../.claude/rules/coding-style.md)：

- 文件 200-400 行典型，800 上限
- 单系统单目录（`systems/focus-timer/` 内 `index.ts` + `timer.ts` + `__tests__/`）
- React 组件 + PixiJS 类**不混在一个文件**
- 不可变数据：所有 systems 函数返回新对象，禁止 mutate 入参

## 依赖管理

- 用 **pnpm**（workspaces 友好，磁盘省）
- root `package.json` 留 workspace 字段，未来加 `packages/shared/` 共享类型
- 锁文件 `pnpm-lock.yaml` 进 git，`node_modules` 不进

## 部署

- **本地开发**：`pnpm dev --host` → 同网段扫二维码上手机
- **公网预览**：Vercel `git push` 自动部署，每个 PR 生成预览 URL
- **未来生产**：迁 Cloudflare Pages 或自家 VPS，PWA cache 策略走 Workbox

## 性能预算

| 指标 | 目标 | 测量方式 |
|---|---|---|
| 首屏 (4G) | < 3s | Lighthouse Mobile |
| JS bundle (gzip) | < 300 KB | `vite build --report` |
| 60 FPS 场景数 | 主界面持续 60 | Pixi devtools |
| 内存峰值 | < 150 MB | Safari Web Inspector |

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| iOS Web Speech 不稳定 | 语音交互弱 | 全功能必须有按钮 fallback |
| PWA 在 iOS 安装路径长 | 用户进不来 | 首页放二维码 + 三步图引导"加到主屏幕" |
| PixiJS v8 生态新 | 教程少 | 关键能力（帧动画/Spine/Filter）先 spike |
| 美术资源未就绪 | demo 难看 | 用 [Kenney.nl](https://kenney.nl) 占位 + AI 生成临时角色 |
