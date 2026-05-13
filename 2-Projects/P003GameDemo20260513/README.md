# P003 K1 Game Demo · V0.4 (4 天交付版)

> ⚠️ **决策前必读：[`docs/DEMO-PRINCIPLES.md`](docs/DEMO-PRINCIPLES.md)** —— 4 个绝对目标 + 范围裁剪表

---

## 4 个绝对目标（不可变更）

1. **手机横版** · 浏览器内模拟真实硬件 **800×300** 横屏画布
2. **小可 AI 实时语音对话**（豆包级实时交互，端到端 ≤ 1.5s 理想）
3. **4 天交付** · 后端先本地 → 验收后迁云端供手机访问
4. **demo 第一原则** · 跑起来 > 优雅，砍一切生产化设计

→ 任一偏离 = 立即砍范围。详见 [`docs/DEMO-PRINCIPLES.md`](docs/DEMO-PRINCIPLES.md) §四 复盘检查清单。

---

## 当前状态（2026-05-13 晚）

- [x] V0.1-V0.3 完成产品对齐与扩展架构设计（保留作为长期路线参考）
- [x] **V0.4 目标重定为 4 天 demo**，4 个原则锚定到文档
- [ ] codex 调研实时语音技术选型（进行中）
- [ ] gemini 评审 4 天范围裁剪可行性（进行中）
- [ ] 出 V0.4 实施计划（合并 codex+gemini 结论）
- [ ] D1-D4 具体开发

---

## 文档导航

| 文档 | 作用 | V0.4 状态 |
|---|---|---|
| [`DEMO-PRINCIPLES.md`](docs/DEMO-PRINCIPLES.md) | **目标锚定（必读）** | ✅ 新增 |
| [`00-product-spec.md`](docs/00-product-spec.md) | 产品规格 + 术语表 | 保留（V1.0 参考） |
| [`01-tech-architecture.md`](docs/01-tech-architecture.md) | 技术架构（V0.3 完整版） | 保留（长期参考） |
| [`02-roadmap.md`](docs/02-roadmap.md) | V1.0 完整 roadmap | **将被 V0.4 4 天计划覆盖** |
| [`03-state-machine.md`](docs/03-state-machine.md) | XState 详图 | 保留（V1.0+ 重启用） |
| [`04-config-tables.md`](docs/04-config-tables.md) | 9 张配置表 | 保留（V1.0+ 重启用） |
| [`05-server-contracts.md`](docs/05-server-contracts.md) | C/S 接口契约 | 保留（参考） |
| [`06-evolution-roadmap.md`](docs/06-evolution-roadmap.md) | 版本演进 + 扩展钩子 | 保留（长期路线图） |
| [`07-v04-implementation-plan.md`](docs/07-v04-implementation-plan.md) | **V0.4 4 天实施计划** | 🚧 待 codex+gemini 出结论后落地 |

**重要约定**：V0.1-V0.3 的文档**不删**，保留作为产品完整愿景的参考（这是 K1 真实的 V1.0-V1.70 路线）。但**V0.4 4 天 demo 实际开发只看 DEMO-PRINCIPLES + 07-v04-implementation-plan**。

---

## 关键术语对齐

| 中文 | 英文 | 注意 |
|---|---|---|
| K1 | k1_product | **产品代号**，不是角色 |
| **小可** | xiaoke | **主角机器人**，用户看到的 IP |
| **指挥官** | commander | 用户称呼 |
| 方舟 | ark | 世界观载体 |
| 探索 / 陪伴 | explore / companion | 专注模式两分支 |
| 星尘 / 家族币 | stardust / family_coin | 双货币 |

---

## V0.4 范围速览（详见 DEMO-PRINCIPLES §二）

### ✅ 4 天内必做（P0+P1）
- 设备外壳 + 800×300 横屏
- 小可 AI 实时语音（核心）
- 主界面：生态缸 + 小可 + 双货币 UI
- 专注循环（启动 → 计时 → 退出 → 奖励）

### ❌ 4 天内不做（推迟到 V1.0+）
- 9 层 LayerManager / XState / 9 张配置表 / 3 份存档冗余
- 唤醒词 + 完整 VAD / 4 级宝箱 + 男女差异化 / 5 个生态缸部件 × 3 级
- 性别选择 / 新手期 3 阶段 / 设置面板硬件 / PWA / 抽卡 / 任务 / 收藏馆 / 所有 V1.5+ 模块

---

## 快速开始（结构未变，V0.4 后端待加）

```bash
cd apps/web
pnpm install
pnpm dev --host
```

后端（D2 启动）：

```bash
cd apps/server          # 待创建
bun dev                 # 或 node --watch
```
