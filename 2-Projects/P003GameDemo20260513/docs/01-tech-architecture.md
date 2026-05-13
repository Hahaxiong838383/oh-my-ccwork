# 01 · 技术架构 (V0.2 · 基于产品定义重写)

> 2026-05-13 · cc · V0.2 → 根据 12 份首批需求文档同步

## 一、目标约束（变更）

| 维度 | V0.1 | V0.2（修正后） |
|---|---|---|
| 设备 | 手机竖屏 | **3.1 寸 800×480 横屏读写台** |
| demo 形态 | 手机 PWA 全屏 | **"读写台模拟器"——手机内嵌设备外壳 + 800×480 横屏画布** |
| 架构 | 纯客户端 | **C/S 架构，服务器为权威**（demo 用 in-memory mock server） |
| 货币 | 单一家族币 | **星尘 + 家族币双货币** |
| 配置 | 硬编码 | **9 张配置表（JSON 模拟 Excel）驱动** |
| 状态机 | 简单路由 | **完整开关机流程 + 中断恢复** |
| 层级 | 5 层 z-index | **9 层 LayerManager** |
| 存档 | localStorage | **Dexie 多份冗余（实时 + 昨日 + 前日 + 云镜像）** |

---

## 二、技术栈（保留 + 调整）

### 保留

| 层 | 选择 | 不变原因 |
|---|---|---|
| 构建 | Vite 5 | 热更+移动调试 |
| 语言 | TypeScript 5 | 系统多必须类型保护 |
| UI 框架 | React 18 | 生态最大 |
| 渲染引擎 | **PixiJS v8** | 2D 硬件加速 + 帧动画 + 粒子，9 层用 Container 嵌套天然契合 |
| 样式 | Tailwind | 移动适配快 |
| 状态 | Zustand | 与 Pixi 解耦干净 |
| 持久化 | **Dexie** | 多版本存档 + 跨表关系 + Dexie observable 同步 store |
| 动效 | Framer Motion + GSAP | UI/动画分工 |
| 语音 | Web Speech API | demo 阶段够用 |
| PWA | vite-plugin-pwa | 加到主屏 |

### 新增

| 层 | 技术 | 用途 |
|---|---|---|
| **Mock Server** | MSW (Mock Service Worker) | 拦截 fetch 模拟 C/S，未来直接换真后端 |
| **配置加载** | Zod | 配置表 schema 校验 |
| **状态机** | XState v5 | 开机/夜航/专注/开箱状态流转 |
| **数字动画** | react-spring | 数字滚动跳动 |
| **设备外壳** | 纯 React + Pixi | 显示读写台工业设计，内嵌 800×480 视口 |

### 不选的更新

- **React Router**：demo 是状态机驱动单页，无需路由
- **Phaser**：仍然不选，9 层 + 状态机 + Pixi 已足够
- **Spine**：V1.0 帧动画，V1.5 再上 Spine

---

## 三、架构总览

```
┌────────────────────────────────────────────────────────────┐
│  设备外壳（DeviceFrame） · React 组件，手机视口铺满          │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  800 × 480 横屏画布（屏幕区域）                       │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │  React UI 层（z=40/45/50/70/80）                │  │  │
│  │  │   主界面胶囊/状态询问按钮/设置面板/弹窗/遮罩    │  │  │
│  │  ├────────────────────────────────────────────────┤  │  │
│  │  │  Pixi Canvas（z=0/10/20/30/60）                 │  │  │
│  │  │   生态缸背景/环境物件/小可/弱特效/强特效        │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
│  设备工业设计：LED 灯指示/物理按键/麦克风孔/外壳光泽      │
└────────────────────────────────────────────────────────────┘

业务逻辑层（与渲染分离）：
┌──────────────────────────────────────────────────────────┐
│  XState 状态机                                            │
│  - boot       开机/欢迎/夜航/状态询问                     │
│  - focus      探索/陪伴/暂离/二次确认                     │
│  - reward     开箱队列/生态缸解锁动画                     │
│  - voice      idle/listening/parsing/confirming           │
├──────────────────────────────────────────────────────────┤
│  Systems（纯函数 TS）                                     │
│  - focus-timer / treasure-box / offline-reward            │
│  - newbie-buff / collection / skin / voice                │
│  - device-sensor (软模拟霍尔/人体/按键)                   │
├──────────────────────────────────────────────────────────┤
│  Mock Server（MSW）                                       │
│  - /api/user/me           星尘/家族币/解锁/新手状态        │
│  - /api/night-report      离线结算                        │
│  - /api/treasure/open     开箱（服务器决定奖励）          │
│  - /api/ecosystem/sync    生态缸状态                      │
│  - /api/save/{slot}       存档读写（3 份冗余）            │
├──────────────────────────────────────────────────────────┤
│  Storage (Dexie)                                          │
│  - saves      ：3 份实时存档（current/yesterday/prev）    │
│  - config_cache：配置表本地缓存                            │
│  - voice_log  ：语音交互日志                              │
└──────────────────────────────────────────────────────────┘
```

**渲染层只读 store / 状态机，不反向调业务**。

---

## 四、9 层 LayerManager（必须代码强约束）

参考 `1.12 美术元素层级规范`：

| 层级 | 名称 | 实现 | 内容 |
|---|---|---|---|
| 0 | 背景层 | Pixi Container | 生态缸主视图 |
| 10 | 环境物件层 | Pixi Container | 5 个生态缸部件（按 Y 轴排序） |
| 20 | 角色层 | Pixi Container | 小可 AnimatedSprite + 新手光环 |
| 30 | 弱特效层 | Pixi Container | 角色脚底光晕/环境粒子 |
| 40 | 普通模式静态 UI | React 层 | 家族币/星尘胶囊 + 设置按钮 |
| 45 | 专注模式静态 UI | React 层 | 专注进度条 + 宝箱累计 + 返舱按钮 |
| 50 | 动态反馈层 | React 层 | 夜航报告/开箱卡片（队列管理） |
| 60 | 强特效层 | Pixi Container | 开箱粒子/生态缸解锁特效 |
| 70 | 遮罩层 | React 层 | 半透明/全黑遮罩 |
| 80 | 模态层 | React 层 | 设置/换装/二次确认 |

**代码约束**：
- Pixi 层用 `LayerManager.add(container, depth)` 注册，自动排序
- React 层用 `<Layer depth={45}>...</Layer>` 包裹，自动 z-index
- 多事件并发用 `FeedbackQueue` 单例排队（最多 3 个 tips，多了丢弃）

---

## 五、状态机（XState v5）

`apps/web/src/state-machine/` 分 4 个机器：

### bootMachine
```
[idle] → [bootAnim] → [welcome] → [nightReport?]
                            ↓
                   [openBoxQueue?] → [ecoUnlockAnim?] → [askMode]
                                              ↓
                              ┌───────────────┴───────────────┐
                              ↓                               ↓
                         [explore]                       [companion]
                          (→ focusMachine)              (→ focusMachine)
```

### focusMachine
```
[running] ⇄ [paused (暂离≤60min)] → [confirmExit] → [exitToReward]
                  ↑ 60min+
            [forceOffline] → 写离线时间
```

### rewardMachine
```
[idle] → [boxOpening] → [showReward] → [next box?]
                                          ↓
                                    [ecoUnlockAnim?] → [done]
```

### voiceMachine
```
[idle] → [wake] → [listening] → [parsing] → [confirm?] → [execute]
                                    ↓ timeout
                                [idle]
```

**中断恢复**：所有机器持久化 currentState 到 Dexie，启动时 hydrate。

---

## 六、Mock Server 设计（MSW）

`apps/web/src/mock-server/handlers.ts` 定义 REST 端点：

```ts
// 用户资产（权威）
GET  /api/user/me                  → { stardust, family_coin, gender, newbie_phase, ... }

// 夜航报告
POST /api/night-report/claim       → 计算并返回 { base_reward, bonus_discovery_box?, supplies_level }

// 开箱
POST /api/treasure/open            → { box_level, rewards: [...] }

// 生态缸
GET  /api/ecosystem/state          → { unlocked_parts: [...], pending_anims: [...] }
POST /api/ecosystem/anim-done      → 标记动画播完

// 存档
GET  /api/save/{slot}              → { snapshot }      slot ∈ {current, yesterday, prev}
PUT  /api/save/{slot}              → ack

// 配置表（开发期开放）
GET  /api/config/{table_name}      → 返回对应 JSON
```

**Why MSW 而不是真 server**：
- demo 阶段无后端工程师投入
- 接口契约一确定，未来 Node/Express/Bun 直接接管 handlers
- MSW 同时支持 dev 和 production（Service Worker 拦截）

---

## 七、配置表系统

`apps/web/src/config/`：

```
config/
├── schemas/                      Zod schema（运行时校验）
│   ├── dictionary.ts
│   ├── drop-table.ts
│   ├── eco-tank.ts
│   └── ...
├── tables/                       JSON 配置（模拟 Excel）
│   ├── dictionary.json
│   ├── drop-table.json
│   ├── eco-tank.json
│   └── ...
├── loader.ts                     启动时统一加载 + Zod 校验，失败抛错
└── index.ts                      暴露强类型 getter：getDictValue('NoanswerTime')
```

**约束**：
- 业务代码**只能**通过 `getDictValue` / `getDropTable` 访问配置
- 直接读 JSON 文件 ❌
- 硬编码常量 ❌（连 `15 * 60 * 1000` 都不行，必须读字典）

---

## 八、存档冗余（Dexie）

```ts
// schema
saves: '++id, slot, updated_at'   // slot: current | yesterday | prev
// 每次写 current 触发：current → yesterday → prev 滚动

// 读取顺序
1. current 完整性校验
2. 失败 → yesterday
3. 失败 → prev
4. 失败 → 云端 mirror（API）
5. 全失败 → 新档警告
```

存档字段读 `SaveId.xlsx`（demo 用 `config/tables/save-id.json`）。

---

## 九、设备硬件软模拟

| 硬件 | demo 模拟 |
|---|---|
| 霍尔开关（开/关盖） | `document.visibilityState` + 显式"关盖"按钮在设备外壳上 |
| 人体传感器 | 鼠标移动事件 + tab 切换事件（30s 无动作=离开） |
| 实体待机按键 | 设备外壳上的物理按键 UI |
| LED 灯（开关+亮度+色温） | 外壳上的 LED 指示灯 + 屏幕外光晕 CSS filter |
| 麦克风 | Web Audio API + 唤醒词识别 |
| 外接屏 | demo 不模拟 |
| 自动息屏（20:00-8:00） | demo 不模拟（可加测试按钮触发） |

抽象层在 `src/systems/device-sensor/`，对状态机暴露统一接口：
```ts
interface DeviceSensor {
  onLidOpen(cb: () => void): Unsubscribe;
  onLidClose(cb: () => void): Unsubscribe;
  onUserPresent(cb: () => void): Unsubscribe;
  onUserAway(cb: (duration_ms: number) => void): Unsubscribe;
  setLED(state: { on: boolean; brightness: 1|2|3; colorTemp: 1|2|3 }): void;
}
```

未来上真硬件，只需要换 sensor 实现。

---

## 十、文件组织（按业务边界划分）

```
apps/web/src/
├── app/                   App 壳 + Provider（store/dexie/msw/xstate）
├── device/                设备外壳 + LED 指示灯（手机视口铺满，包住 800×480 屏幕）
├── screen/                800×480 屏幕区域路由器（根据状态机当前 state 切换 scene）
├── scenes/                每个 scene 一个目录
│   ├── BootAnim/
│   ├── Welcome/
│   ├── NightReport/       夜航报告（基础奖励 + 额外发现）
│   ├── AskMode/           状态询问（探索/陪伴）
│   ├── Focus/             专注界面（3 种随机布局）
│   ├── OpenBox/           开箱
│   ├── EcoUnlock/         生态缸解锁/升级动画
│   ├── Onboarding/        首次启动引导（含性别选择）
│   ├── ShutdownFarewell/  关机告别
│   └── Settings/          设置面板（80 模态层）
├── game/                  Pixi 渲染层
│   ├── layer-manager.ts   9 层注册器
│   ├── ecosystem/         生态缸（背景+5部件渲染）
│   ├── xiaoke/            小可（待机动画轮播 + 状态切换）
│   ├── treasure/          宝箱（4 级外观 + 男女差异）
│   └── effects/           粒子/光环/特效
├── systems/               业务逻辑（纯 TS，可单测）
│   ├── focus-timer/
│   ├── treasure-box/
│   ├── night-report/
│   ├── newbie-buff/
│   ├── voice/
│   ├── device-sensor/
│   ├── number-format/     ≥1M→"X K+" 规则
│   └── feedback-queue/    动态反馈层队列
├── state-machine/         XState v5
│   ├── boot-machine.ts
│   ├── focus-machine.ts
│   ├── reward-machine.ts
│   ├── voice-machine.ts
│   └── root-machine.ts    顶层编排
├── mock-server/           MSW handlers + factories
├── config/                配置表（schemas + tables + loader）
├── store/                 Zustand stores（user/ui/settings）
├── storage/               Dexie schema + 3 份存档管理
├── ui/                    通用组件（Button/Modal/Toast）
└── i18n/                  文案中心（指挥官称呼/小可对白）
```

**目标**：任何子目录都能独立单测，scene 之间只通过状态机通信，不互相 import。

---

## 十一、性能预算（按 800×480 真机调整）

| 指标 | 目标 | 备注 |
|---|---|---|
| 首屏（4G） | < 3s | 含 PWA cache |
| JS bundle gzip | < 350 KB | Pixi+XState+React 比 V0.1 略大 |
| 60 FPS 场景 | 主界面持续 60 | Pixi 在 800×480 完全无压力 |
| 内存峰值 | < 200 MB | demo 比真机宽松 |
| 设备外壳渲染 | < 5% CPU | 静态 + CSS filter |

---

## 十二、风险与对策（变化点）

| 风险 | 影响 | 对策 |
|---|---|---|
| 设备外壳在小屏手机上压缩到 800×480 难看 | 体验差 | 外壳留可隐藏开关 → 全屏只看 800×480 |
| Mock server 与未来真后端契约漂移 | 重构成本 | 用 OpenAPI YAML 当契约源，生成 TS 类型 + MSW handler |
| 9 层 z-index 与 Pixi container 混用容易乱 | bug 多 | LayerManager 测试覆盖率必须 ≥90% |
| 配置表 JSON 难手工维护 | 易错 | 加 `pnpm config:validate` 命令跑 Zod |
| 唤醒词在 iOS 失效 | 语音体验断 | 1.0 阶段就明确按钮 fallback，唤醒词当"加分项" |
| XState 学习曲线 | 团队上手慢 | 配 visualizer + 状态图导出到 docs/03-state-machine.md |
