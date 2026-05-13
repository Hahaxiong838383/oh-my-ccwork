# P003 K1 Game Demo · V0.3

> **K1 读写台**（小可机器人 × 飞船舷窗生态缸）V1.0 核心循环的 Web 原型。
> 用"读写台模拟器"思路 —— 手机上看到设备外壳，内嵌真实 **800×480 横屏**画布。
>
> 框架来源：
> - [K1产品游戏路线框架](https://futurus.feishu.cn/wiki/PFELwNaTmi5CXskD2PDc5lfWncb)
> - [首批需求 V1.0](https://futurus.feishu.cn/wiki/Qyfgw1PIiimx7kkP6nycota6nwh) （12 份功能定义）
> - [第三批需求 V1.3-V1.70](https://futurus.feishu.cn/wiki/J71cwDHgwi86FSkrF2hcWpodn3b) （15 份扩展模块）
> - [版本规划目录](https://futurus.feishu.cn/wiki/IOGAw6skuizpYvkHyAJcH2UPnKc) （4/14 产品评审定案）

---

## 当前状态（2026-05-13）

- [x] **V0.3 架构对齐到完整版本演进路线**
  - 6 份文档：[00 产品规格](docs/00-product-spec.md) / [01 技术架构](docs/01-tech-architecture.md) / [02 V1.0 Roadmap](docs/02-roadmap.md) / [03 状态机](docs/03-state-machine.md) / [04 配置表](docs/04-config-tables.md) / [05 服务器契约](docs/05-server-contracts.md) / [**06 版本演进路线**](docs/06-evolution-roadmap.md)
- [x] 代码骨架 + V1.0 必备的通用 Tips/弹窗 + V1.5+ 扩展钩子
- [ ] M0 `pnpm install` + `pnpm dev` 跑通（下一步）
- [ ] M1-M7 8 个 milestone（约 2.5 周）

---

## 快速开始

```bash
cd apps/web
pnpm install
pnpm dev --host          # 同网段手机扫码
pnpm config:validate     # 检查 9 张配置表 Zod schema
```

---

## 关键术语对齐

| 中文 | 英文 | 注意 |
|---|---|---|
| K1 | k1_product | **产品代号**，不是角色 |
| **小可** | xiaoke | **主角机器人**，用户看到的 IP |
| **指挥官** | commander | **用户称呼**，小可永远这么叫 |
| 方舟 | ark | 飞船世界观载体 |
| 夜航报告 | night_report | 离线收益+额外发现的仪式化包装 |
| 探索 / 陪伴 | explore / companion | 专注模式两分支 |
| 星尘 / 家族币 | stardust / family_coin | **双货币** |
| 灵石 | spirit_stone | V1.51 抽卡的"重复转化货币" |
| 换模式 | personality preset | V1.51 起换皮肤 = 切人格预设（5维属性 + 5套预设） |

---

## V0.3 关键变化（基于第三批文档）

### 新增（V1.0 demo 立即用）

- **通用 Tips 队列**（`ui/Tips.tsx` + `store/feedback-queue.ts`）—— ≤3 条单例队列，10字/20字截断
- **通用二级弹窗**（`ui/ConfirmModal.tsx`）—— 正文 12/24 字，按钮 2/4 字，全场景统一

### 扩展钩子（demo 不实现，但接口稳定）

- **小可人格**（`store/user-store.personality`）—— 5 维属性 + 6 套预设（V1.51 抽卡解锁）
- **多生态缸**（`store/user-store.ecoTanks`）—— 单缸数组结构（V1.5+ 多缸切换）
- **语音结构化响应**（`systems/voice/response-schema.ts`）—— `{text, voiceId, action, emotion, intent}` Zod schema
- **AI 意图路由**（`systems/voice/intent-router.ts`）—— 业务命令 + AI 子能力 + 闲聊兜底
- **奖励容器抽象**（`systems/treasure-box/reward-container.ts`）—— 宝箱/抽卡/额外发现共用底层
- **Scene Plugin 模式**（`scenes/manifest.ts`）—— V1.60 加 AVG/AI 编程 scene 不返工
- **任务系统占位**（`systems/task/README.md`）—— 服务器侧防作弊架构预留
- **小可骨骼接口**（`game/xiaoke/index.ts`）—— playAnim/setEmotion 接口稳定，V1.5 切 Spine 零改动

---

## 架构总览

```
┌────────────────────────────────────────────────────┐
│         设备外壳（手机视口铺满）                     │
│  ┌──────────────────────────────────────────────┐  │
│  │   800 × 480 横屏屏幕                          │  │
│  │   ┌────────────────────────────────────────┐ │  │
│  │   │ React UI (z=40/45/50/70/80)            │ │  │
│  │   │ Pixi Canvas (z=0/10/20/30/60)          │ │  │
│  │   │ Tips queue / ConfirmModal (z=50/80)    │ │  │
│  │   └────────────────────────────────────────┘ │  │
│  └──────────────────────────────────────────────┘  │
│  LED 指示 / 物理按键 / 麦克风孔                     │
└────────────────────────────────────────────────────┘

业务逻辑：
  XState 4 机器（boot/focus/reward/voice）
    ↓
  Systems（focus-timer / reward-container / night-report / voice 含 intent router / task）
    ↓
  Mock Server (MSW)：treasure / gacha / task / personality / weather 等接口
    ↓
  Dexie (3 份存档) + Config (9 张表 + Zod)
```

详见 [01-tech-architecture.md](docs/01-tech-architecture.md) + [06-evolution-roadmap.md](docs/06-evolution-roadmap.md)。

---

## 完整版本路线（来自版本规划目录）

| 版本 | 时间 | 关键模块 |
|---|---|---|
| **V1.0** | 5/25 | 主界面+生态缸基础+小可默认皮肤+设置+小程序+断网+OTA |
| V1.1 | 6/30 | 藏品+专注+开关机+OTA动画+小程序积分+语音对话+断网语音 |
| V1.2 | 7/15 | 夜航+新手+生态缸升级+小可换肤+通用Tips弹窗+小程序V1.2 |
| V1.3 | 7/30 | 数据埋点+WEB后台+语音界面升级 |
| V1.4 | 8/15 | 新手引导+小程序V1.2 |
| V1.5 | — | 语音界面升级+AI 语音应用场景 |
| V1.51 | — | 换模式+抽卡 |
| V1.52 | — | 收藏馆+小程序 V1.3 |
| V1.53 | — | 任务系统+语音聊天丰富化 |
| V1.60 | — | AI 生成 AVG |
| V1.70 | — | 用户 AI 编程 |

每个版本对应的架构钩子已在 V0.3 就位，详见 [docs/06-evolution-roadmap.md](docs/06-evolution-roadmap.md)。

---

## 目录

```
P003GameDemo20260513/
├── docs/
│   ├── 00-product-spec.md
│   ├── 01-tech-architecture.md
│   ├── 02-roadmap.md
│   ├── 03-state-machine.md
│   ├── 04-config-tables.md
│   ├── 05-server-contracts.md
│   └── 06-evolution-roadmap.md     ← V0.3 新增
├── apps/web/
│   └── src/
│       ├── app/
│       ├── device/                  设备外壳
│       ├── screen/                  屏幕路由器
│       ├── scenes/                  + manifest.ts (plugin 注册器)
│       ├── game/
│       │   ├── layer-manager.ts     9 层
│       │   ├── ecosystem/
│       │   └── xiaoke/              + playAnim/setEmotion 稳定接口
│       ├── systems/
│       │   ├── focus-timer/
│       │   ├── treasure-box/
│       │   │   └── reward-container.ts   ← V0.3 抽卡共用抽象
│       │   ├── offline-reward/
│       │   ├── voice/
│       │   │   ├── response-schema.ts    ← V0.3 结构化响应
│       │   │   └── intent-router.ts      ← V0.3 意图路由
│       │   ├── task/                     ← V0.3 占位
│       │   ├── number-format/
│       │   └── device-sensor/
│       ├── state-machine/
│       ├── mock-server/
│       ├── config/
│       │   ├── schemas.ts
│       │   ├── loader.ts
│       │   ├── validate.ts
│       │   └── tables/             dictionary / drop-table / eco-tank / newbie-phase
│       ├── store/
│       │   ├── user-store.ts       + personality + ecoTanks
│       │   ├── device-store.ts
│       │   ├── settings-store.ts
│       │   └── feedback-queue.ts   ← V0.3 Tips 队列
│       └── ui/
│           ├── Tips.tsx            ← V0.3 通用 Tips
│           ├── ConfirmModal.tsx    ← V0.3 通用弹窗
│           ├── TopBar.tsx
│           ├── XiaokePanel.tsx
│           ├── NewbieHalo.tsx
│           └── FocusControl.tsx
└── assets/
```

---

## 与 V0.1/V0.2 的差异

| 维度 | V0.1 | V0.2 | V0.3 |
|---|---|---|---|
| 设备 | 手机竖屏 | 设备外壳 + 800×480 横屏 | 同 V0.2 |
| 角色 | K1 机器人 | 小可（K1=产品） | 同 V0.2 |
| 货币 | 单货币 | 星尘 + 家族币 | + **灵石**（抽卡转化） |
| 架构 | 纯客户端 | C/S + Mock Server | + 任务防作弊 / 抽卡接口 |
| 层级 | 5 层 | 9 层 LayerManager | 同 V0.2 |
| 状态机 | 简单计时 | XState 4 机器 | + voice triggerSource 维度 |
| 小可 | 简单帧动画 | playAnim 接口 | + setEmotion + 5维人格预设 |
| 语音 | 唤醒词 | 唤醒词 + 命令 | + 结构化响应 + 意图路由 |
| 通用 UI | 临时拼凑 | 临时拼凑 | **Tips 队列 + ConfirmModal** 统一 |
| Scene | 静态 if/else | 静态 switch | **Plugin manifest** 注册 |
| 扩展 | — | — | **任务/抽卡/收藏馆/AVG/编程** 接口预留 |

---

## 方法论

- [BRO-PDCA](../../3-Thinking/01-BRO-PDCA方法论.md) —— O1/O2 已对齐，进入 P1 拆解
- 每个 milestone 完成追加到 [task-log](../../0-System/task-log.md)
- 每个 milestone 完成跑一次"思想实验"：模拟引入某个第三批功能，看接入成本是否为 0（详见 [docs/06-evolution-roadmap.md §四](docs/06-evolution-roadmap.md)）
