# P003 K1 Game Demo · V0.2

> **K1 读写台**（小可机器人 × 飞船舷窗生态缸）V1.0 核心循环的 Web 原型。
> 用"读写台模拟器"思路 —— 手机上看到设备外壳，内嵌真实 **800×480 横屏**画布。
> 框架来源：[K1产品游戏路线框架](https://futurus.feishu.cn/wiki/PFELwNaTmi5CXskD2PDc5lfWncb) + [首批需求](https://futurus.feishu.cn/wiki/Qyfgw1PIiimx7kkP6nycota6nwh)

---

## 当前状态（2026-05-13）

- [x] **V0.2 架构对齐到产品定义**（12 份首批需求文档同步）
  - 5 份文档：[00 产品规格](docs/00-product-spec.md) / [01 技术架构](docs/01-tech-architecture.md) / [02 Roadmap](docs/02-roadmap.md) / [03 状态机](docs/03-state-machine.md) / [04 配置表](docs/04-config-tables.md) / [05 服务器契约](docs/05-server-contracts.md)
- [x] 代码骨架（设备外壳 + 800×480 画布 + 9 层 + 状态机占位）
- [ ] M0 `pnpm install` + `pnpm dev` 跑通（下一步）
- [ ] M1-M7 8 个 milestone（约 2.5 周）

---

## 快速开始

```bash
cd apps/web
pnpm install
pnpm dev --host          # 同网段手机扫码
```

---

## 关键术语对齐（务必先理解）

| 中文 | 英文 | 注意 |
|---|---|---|
| K1 | k1_product | **产品代号**，不是角色 |
| **小可** | xiaoke | **主角机器人**，用户看到的 IP |
| **指挥官** | commander | **用户称呼**，小可永远这么叫 |
| 方舟 | ark | 飞船世界观载体 |
| 夜航报告 | night_report | 离线收益+额外发现的仪式化包装 |
| 探索模式 | explore | 专注分支 A（小可不在场） |
| 陪伴模式 | companion | 专注分支 B（小可读书陪读） |
| 星尘 / 家族币 | stardust / family_coin | **双货币**，不是单一货币 |

---

## 架构一览

```
┌────────────────────────────────────────────────────┐
│         设备外壳（手机视口铺满）                     │
│  ┌──────────────────────────────────────────────┐  │
│  │   800 × 480 横屏屏幕                          │  │
│  │   ┌────────────────────────────────────────┐ │  │
│  │   │ React UI (z=40/45/50/70/80)            │ │  │
│  │   │ Pixi Canvas (z=0/10/20/30/60)          │ │  │
│  │   └────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────┘  │
│  LED 指示 / 物理按键 / 麦克风孔                     │
└────────────────────────────────────────────────────┘

XState 4 机器（boot/focus/reward/voice）
  ↓
Systems（focus-timer / treasure-box / night-report / ...）
  ↓
Mock Server (MSW) → 未来切真后端零代码改动
  ↓
Dexie（3 份存档冗余）+ Config Loader（9 张配置表 + Zod 校验）
```

详见 [01-tech-architecture.md](docs/01-tech-architecture.md)。

---

## 目录

```
P003GameDemo20260513/
├── docs/                                     文档（V0.2 全套）
│   ├── 00-product-spec.md                    产品规格 + 术语表
│   ├── 01-tech-architecture.md               技术架构
│   ├── 02-roadmap.md                         M0-M7 共 8 个 milestone
│   ├── 03-state-machine.md                   4 个 XState 机器详图
│   ├── 04-config-tables.md                   9 张配置表索引
│   └── 05-server-contracts.md                C/S 接口契约
├── apps/web/
│   └── src/
│       ├── app/                              App 壳 + Provider
│       ├── device/                           设备外壳（LED/按键）
│       ├── screen/                           800×480 屏幕路由器
│       ├── scenes/                           9 个 scene（BootAnim/Welcome/...）
│       ├── game/                             Pixi 渲染（layer-manager + ecosystem + xiaoke）
│       ├── systems/                          业务逻辑（纯 TS）
│       ├── state-machine/                    XState 4 机器
│       ├── mock-server/                      MSW handlers
│       ├── config/                           Schemas + Tables + Loader
│       ├── store/                            Zustand
│       ├── storage/                          Dexie schema + 3 份存档
│       ├── ui/                               通用组件
│       └── i18n/                             文案中心
└── assets/                                   美术原档（与代码分离）
```

---

## 与 V0.1 的差异

| V0.1（之前理解） | V0.2（基于产品定义） |
|---|---|
| 手机竖屏 | 设备外壳 + 800×480 横屏 |
| K1 机器人 | 小可（K1=产品） |
| 单货币家族币 | 双货币星尘+家族币 |
| 纯客户端 | C/S 架构（mock server） |
| 5 层 z-index | 9 层 LayerManager |
| 简单计时 | XState 4 个机器 + 中断恢复 |
| 硬编码 15min | 9 张配置表 + Zod |
| 5 个 milestone (1.5 周) | 8 个 milestone (2.5 周) |

---

## 方法论

- [BRO-PDCA](../../3-Thinking/01-BRO-PDCA方法论.md) —— O1/O2 已对齐，进入 P1 拆解
- 每个 milestone 完成追加到 [task-log](../../0-System/task-log.md)
- 配置表变更必须 `pnpm config:validate` 通过
- 状态机修改必须导出 SVG 到 `docs/diagrams/`
