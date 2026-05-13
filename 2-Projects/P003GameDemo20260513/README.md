# P003 K1 Game Demo · 2026-05-13

> **K1 产品 V1.0 MVP 核心循环 Web 端原型**，移动端优先，PWA 一键扫码上手机。
>
> 产品框架来自飞书 wiki [K1产品游戏路线框架](https://futurus.feishu.cn/wiki/PFELwNaTmi5CXskD2PDc5lfWncb)（内部，需权限）。

## 一句话

让 K1 的*开盖→离线收益→专注→15min 宝箱→开箱→生态缸成长*核心循环，在浏览器里跑起来，扫码即体验。

## 当前状态

- [x] 架构方案确定（见 [`docs/01-tech-architecture.md`](docs/01-tech-architecture.md)）
- [x] 目录脚手架
- [x] 文档框架（产品规格摘录 / 技术架构 / V1.0 demo roadmap）
- [ ] `apps/web` 安装依赖 + 跑 `pnpm dev`
- [ ] V1.0 demo 五个 milestone（详见 [`docs/02-roadmap.md`](docs/02-roadmap.md)）

## 快速开始

```bash
cd apps/web
pnpm install            # 首次
pnpm dev                # 本地开发 http://localhost:5173
pnpm dev --host         # 同网段手机扫码访问
pnpm build              # 产线构建
pnpm preview            # 本地预览构建结果
```

## 目录

```
P003GameDemo20260513/
├── README.md                  # 本文件
├── docs/
│   ├── 00-product-spec.md     # 飞书框架要点摘录（demo 范围）
│   ├── 01-tech-architecture.md# 技术架构决策
│   └── 02-roadmap.md          # V1.0 demo 五个 milestone
├── apps/
│   └── web/                   # Vite + React + PixiJS + Tailwind
│       ├── src/
│       │   ├── app/           # React 应用壳
│       │   ├── scenes/        # 业务场景（Onboarding/Main/Reward）
│       │   ├── game/          # PixiJS 渲染（ecosystem/k1/effects）
│       │   ├── systems/       # 核心系统（focus-timer/treasure-box/offline-reward/voice）
│       │   ├── store/         # Zustand 状态
│       │   ├── ui/            # 通用 UI 组件
│       │   └── assets/        # 占位资源
│       └── public/            # 静态资源 + PWA manifest
└── assets/                    # 美术资源原档（与代码分离）
    ├── characters/k1/
    ├── ecosystem/
    ├── ui/
    └── sfx/
```

## 设计原则

1. **移动优先**：所有布局以 iPhone 13 Pro (390×844) 为基准
2. **低摩擦交互**：动效自动播放、关键反馈无需点击
3. **离线可用**：PWA + IndexedDB，断网也能跑完整循环
4. **资源占位**：先用色块/简笔代替最终美术，跑通逻辑再换皮

## 方法论引用

遵循 [BRO-PDCA](../../3-Thinking/01-BRO-PDCA方法论.md)：
- 当前阶段 **O1+O2 已对齐**（Web demo + 移动体验 + V1.0 MVP 范围）
- 进入 **P1 拆解**（见 `docs/02-roadmap.md`）
- 每个 milestone 完成后追加到 [`0-System/task-log.md`](../../0-System/task-log.md)
