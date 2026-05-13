# 06 · 版本演进路线与架构钩子（V0.1）

> 2026-05-13 · cc · 基于第三批需求 + 4/14 产品评审版本规划
> 这份文档解决一个问题：**V1.0 demo 怎么在不返工的前提下，让 V1.5-V1.70 都能平滑加入。**

---

## 一、官方版本节奏

来源：[版本规划目录](https://futurus.feishu.cn/wiki/IOGAw6skuizpYvkHyAJcH2UPnKc)（产品 2026-04-14 评审定案）

| 版本 | 计划时间 | 关键模块 | 来源文档 |
|---|---|---|---|
| **V1.0** | 2026-05-25 | 主界面/生态缸基础/小可默认皮肤/设置/小程序/断网/OTA | 1.6/1.7/1.8/1.11 + V1.5_1.3/1.4/1.5 |
| V1.1 | 2026-06-30 | 藏品/专注/开关机/OTA动画/小程序积分/语音对话/断网语音 | 1.10/1.3/1.5/1.9 |
| V1.2 | 2026-07-15 | 夜航/新手/生态缸升级/小可换肤/**通用Tips弹窗** | 1.2/1.4/1.7/1.8/**3.13**/3.15 |
| V1.3 | 2026-07-30 | 数据埋点/WEB 后台/**语音界面升级** | V1.5_1.2/1.6/**3.1** |
| V1.4 | 2026-08-15 | 新手引导/小程序 V1.2 | V1.5_1.1/3.15 |
| V1.5 | — | **语音界面升级+AI 语音应用场景** | **3.1/3.2** |
| V1.51 | — | **换模式 + 抽卡** | **3.4/3.5** |
| V1.52 | — | **收藏馆 + 小程序 V1.3** | **3.6/3.9** |
| V1.53 | — | **任务系统 + 语音聊天丰富化** | **3.7/3.8** |
| V1.60 | — | **AI 生成 AVG** | **3.10** |
| V1.70 | — | **用户 AI 编程** | **3.11** |
| 未排期 | — | 小可状态机升级 / 生态缸扩展 / AI 互动故事 | 3.3 / 3.12 / 3.14 |

---

## 二、第三批 15 份文档对架构的影响矩阵

> 标 ⭐ = V1.0 demo 阶段就需要在代码里留钩子的；标 □ = V1.0 不需要但 V1.5+ 用得到。

### ⭐ 立即纳入 V0.2（V1.0 demo 必须用）

#### 3.13 通用 Tips + 二级弹窗（V1.2 排期，但 V1.0 多处已用）

**规则提炼**：
- **Tips**：屏幕中央，文字 ≤10 字一行，≤20 字两行字号变小，>20 字截断。浮入→停 1s→浮出。**队列最多 3 个**，满了丢弃。
- **二级弹窗**：正文 ≤12 字一行，≤24 字两行变小，>24 字截断。按钮**优先 2 字**（保排版），3-4 字需重出美术，>4 字截断。

**架构落地**：
- `apps/web/src/ui/Tips.tsx` —— 单例 + 队列管理
- `apps/web/src/ui/ConfirmModal.tsx` —— 通用二级弹窗
- `apps/web/src/store/feedback-queue.ts` —— Tips 队列（≤3 单例）
- **V1.0 强制使用场景**：星尘不足、设置未成功、退出专注二次确认、新手期 voice 提示、识别失败兜底

---

### ⭐ 必须预留扩展钩子（V1.0 demo 不实现，但接口要稳定）

#### 3.4 换肤升级 → 换"人格预设"（V1.51）

**核心理念**：换肤不只换外观，**同时切换小可的整个人格**。参考 Claude Code Buddy 五维数值注入。

**小可 5 维属性**：
- 想象力 imagination（用故事和比喻解释抽象概念的脑洞）
- 勇气 courage（鼓励尝试、面对失败的力度）
- 幽默感 humor（说话有趣、让孩子笑的意愿）
- 好奇心 curiosity（对世界的探索欲）
- 温暖 warmth（情感支持和共情能力）

**5 套预设**（每套 = 一组数值 + 系统提示词 + 美术皮肤）：
1. 小探险家
2. 故事大王
3. 搞笑搭档
4. 好奇宝宝
5. 治愈系

**架构落地（V0.2 现在就做）**：
```ts
// user-store.ts
personality: {
  presetId: 'default' | 'explorer' | 'storyteller' | 'comedian' | 'curious' | 'healer';
  imagination: number;   // 0-100
  courage: number;
  humor: number;
  curiosity: number;
  warmth: number;
}

// systems/voice/personality-prompt.ts
// 把 personality 数值注入 LLM 系统提示词
```

V1.0 阶段 personality 字段存在但只有 `default` 预设，V1.51 加入抽卡和切换。

---

#### 3.3 小可状态机升级（未排期，但语义在 3.4 已露面）

**升级方向**：帧动画 → **骨骼动画 + 动画融合**（动作衔接更自然）。

**架构落地**：
- `game/xiaoke/index.ts` 接口**对外只暴露 `playAnim(name, options)`**，内部实现可以从 AnimatedSprite 换到 Spine 而不影响调用方
- 状态名按"动作类"（idle_wave / idle_spin / idle_nod / walk / cheer / sad / read）+ "情绪类"（happy / sad / excited / calm）正交建模

---

#### 3.8 语音聊天丰富化（V1.53）

**核心技术**：用 **MCP + function calling** 让大模型输出**结构化结果**（不只是纯文本回答，还附带《动作》《表情》字段）。

**输出格式（示例）**：
```ts
type VoiceResponse = {
  text: string;              // 小可要说的话
  voiceId?: number;          // 命中预设语音库
  action?: XiaokeAnim;       // 配合的动作（cheer / wave / read 等）
  emotion?: XiaokeEmotion;   // 表情（happy / curious / warm）
  intent?: IntentType;       // 命中的业务意图（开始专注/换装/查天气/...）
}
```

**架构落地（V0.2 现在就做）**：
- `systems/voice/response-schema.ts` —— 定义 VoiceResponse Zod schema
- 即使 V1.0 demo 用按钮 fallback，**返回结构也按这个格式走**，未来直接接 LLM

---

#### 3.5 抽卡系统（V1.51）

**核心规则**：
- 每次 1 抽（不做 10 连）
- 7 抽保底，第 7 抽必出新模式
- 重复模式 → 转灵石
- 灵石可兑换任意模式
- 资源是星尘（**唯一来源 = 离线收益**）—— 每 12h 攒一次 = 抽 1 发
- 5 个皮肤 → 35 天目标留存周期

**架构理念**：**抽卡 ≠ 独立系统，是宝箱系统的特化**。共享"奖励容器 → 概率掉落 → 序列保底 → 重复转化"机制。

**架构落地**：
- `systems/treasure-box/` 抽象为 `RewardContainer` —— 输入：containerType + 概率配置；输出：Reward[]。宝箱、抽卡、夜航额外发现都用同一套底层。
- `config/tables/gacha-config.json` 预留（V1.51 填）
- `mock-server` 加 `/api/gacha/draw` 接口预留

---

#### 3.1 语音界面升级（V1.3-V1.5）

**两条入口路径**（产品文档明确区分）：

| 路径 | 触发 | UI | 进场动画 |
|---|---|---|---|
| **路径 A**：游戏进程触发 | 进入特定 scene 自动开 VAD | 浮窗（不遮主流程） | **无** |
| **路径 B**：用户唤醒 | 喊"小可小可" | 全屏/浮层 | **有侧边滑入** |

**完整 7 状态**（替换 V0.2 简化版）：
待机 / 唤醒成功 / 聆听中 / 思考中 / 响应中 / 被打断 / 异常 / 超时退出

**断网分级响应**（来自 V1.5_1.4，3.1 引用）：
- 断网 0-5s → "网络有点不稳定，稍等"
- 30s → 自动重置网络
- 重置失败 1 → 提示再试
- 重置失败 2 → 引导家长扫码

**架构落地**：
- `state-machine/voice-machine.ts` 加 `triggerSource: 'auto' | 'wake'` 顶层维度
- V1.0 demo 先做路径 B（有进场动画）的骨架，V1.3 加路径 A

---

#### 3.2 AI 语音应用场景（V1.5）

**子能力清单**（这是 AI 语音的"插件"）：
- 天气查询（带儿童视角穿衣/出行建议）
- 百科问答（儿童化语言，反搜索引擎式罗列）
- （未来）学科辅导、伴读

**性能指标**：
- 响应 ≤ 5s
- 意图识别准确率 ≥ 95%
- 回答正确率 ≥ 95%（人工抽检）
- 服务可用性 ≥ 99.5%

**架构落地**：
- `systems/voice/intent-router.ts` —— 输入 transcript，输出 `{intent, slots, fallback}`
- 每个 AI 子能力 = 一个 `intents/<weather|encyclopedia|...>.ts` 模块
- V1.0 demo 不接 LLM，但 intent router 框架就位

---

#### 3.7 任务系统（V1.53）

**核心约束**（产品文档明确）：
- **家长不能凭空发奖励** —— 必须和设备使用挂钩
- **家长和孩子都不能手动点完成** —— 必须设备后台自动达标
- **"小小愿望"** —— 家长+孩子共建愿望，花家族币达成（倒推使用时长预估）

**架构落地**：
- 任务执行**必须 server-side 判定**（mock server 同步实现，未来直接换真后端）
- `systems/task/` 模块（V0.2 占位）
- 设备-小程序双端共用 `/api/task/*` 接口
- 防作弊：客户端只上报传感器原始数据（focus_seconds），不上报"已完成"

---

#### 3.6 收藏馆 + 3.9/3.15 小程序（V1.2/V1.52）

**双端架构**：
- 3.1 寸读写台 + 小程序家长端
- 数据完全共享（藏品/星尘/家族币/任务/愿望）
- 小程序 V1.2 起承担"家长视角"（孩子使用情况、任务发布、收藏馆查看）

**架构落地**：
- mock server 接口设计**预见**双端调用（同一份接口，端类型在 header 标注）
- demo 不做小程序客户端，但接口设计已预见

---

#### 3.10/3.11/3.14 AI 内容生成场景（V1.60+）

**三种全新 scene 类型**：
- **3.10 AI AVG**：AI 生成的视觉小说式互动游戏
- **3.11 用户 AI 编程**：预设应用库 + 引导输出（小程序查看作品）
- **3.14 AI 互动故事**：AI/用户交替写故事

**架构落地**：
- `scenes/` 目录按 plugin 模式组织，每个 scene 自带 manifest（name/version/enter-state/exit-event）
- `screen/Screen.tsx` 路由器从 state machine 动态加载 scene（不是 hardcoded switch case）
- V1.0 demo 用静态路由，但 plugin 模式已就位

---

#### 3.12 生态缸扩展（未排期）

**推测内容**：多生态缸切换（用户拥有多个生态缸，切换观测）

**架构落地**：
- `user-store.ecoTanks: { tankId: string; unlockedParts: ... }[]`
- `currentEcoTankId` 单独字段
- `getEcoPart(partId, tankId)` 加 tankId 维度
- V1.0 demo 只支持单缸（`tankId: 'default'`）

---

## 三、V0.2 框架更新清单（基于上述钩子）

### 必改

1. **新增 `ui/Tips.tsx`** —— 单例 + 队列管理（V1.0 多处已用）
2. **新增 `ui/ConfirmModal.tsx`** —— 二级弹窗（V1.0 二次确认用）
3. **`store/user-store.ts`** —— 加 personality 5 维 + ecoTanks 多缸字段
4. **`game/xiaoke/index.ts`** —— playAnim 接口稳定，预留 Spine 切换点
5. **`systems/voice/`** —— 加 `response-schema.ts` + `intent-router.ts` + 加 triggerSource 维度
6. **`systems/treasure-box/`** —— 抽象 `RewardContainer` 接口，宝箱/抽卡共用
7. **`systems/task/`** —— 占位 + 接口契约
8. **`mock-server/`** —— 加 task/gacha/intent/personality 接口契约 stub
9. **`scenes/`** —— 改为 plugin 模式（每个 scene 自带 manifest）
10. **`config/tables/`** —— 新增 gacha-config.json、personality-preset.json（V1.51 填，V1.0 留空 schema）

### 不改

- 9 层 LayerManager（已经够通用）
- XState 4 机器（仅 voice 加 triggerSource 维度）
- Dexie 存档（schema 字段加而已）
- C/S 边界（mock server 加接口而已）

---

## 四、扩展点验证（demo 期间持续检验）

每个 milestone 完成时，**模拟引入第三批某个功能**做"思想实验"：

| Milestone | 模拟引入 | 验证点 |
|---|---|---|
| M2 完成 | 引入 3.13 Tips/弹窗 | 现有 UI 改造成本 = 0（直接换组件） |
| M3 完成 | 引入 3.5 抽卡 | 是否能复用宝箱系统？接口契合度 |
| M4 完成 | 引入 3.7 任务防作弊 | 客户端是否真的没有"假完成"路径 |
| M5 完成 | 引入 3.4 换人格 | personality 注入到 voice prompt 改动量 |
| M6 完成 | 引入 3.1 语音两路径 | triggerSource 维度是否够 |
| M7 完成 | 引入 3.10 AVG | scene plugin 是否真能加 |

任一环节"接不进去"= 架构有漏洞，立即返工。
