# 生命周期与自进化

> 从 CLAUDE.md 解耦的生命周期模块。定义钩子、调度、自进化授权。

---

## 自进化自主升级授权

每日自进化检查（`/learn`、进化自查）发现升级候选时：
- 🔴 **红标**（高优先级）→ 立即自主执行
- 🟡 **黄标**（中优先级）→ 自主执行
- ⚪ **白标**（低优先级 / 方向性变更）→ 列出候选，等老板确认

**升级范围**：配置文件、规则文件、memory 文件、skill 文件的改善性修改。
**不包括**：架构变更、新功能开发、影响生产服务的修改。
升级完成后发一条简报：升级了哪些、改善了什么、跳过了什么。

---

## 进化闭环

```
Task Execution (task-log + trajectories)
     ↓
轨迹分析（grep friction/decision 事件）
     ↓
insights 摩擦提取（每3天 09:00）
     ↓
帕累托评估（friction_skill × token_cost 双维度）
     ↓
进化自查 Review（每3天 09:30）
     ↓
Decision: 红/黄/白分级
     ↓
/learn 每日提取（22:33）
     ↓
Red/Yellow → 自主实施
     ↓
更新 memory-items + RECENT_EVENTS
     ↓
/retro 周度复盘（周日 22:45）
```

### 帕累托优化规则

进化方向同时考虑两个维度，避免"减少摩擦但炸 token"的伪优化：
- **高摩擦 + 高成本**：最高优先级改进目标
- **低摩擦 + 高成本**：值得优化（降成本）
- **高摩擦 + 低成本**：值得优化（降摩擦）
- **低摩擦 + 低成本**：不动，已在帕累托前沿

`/retro` 复盘时输出 token 效率趋势：同类任务的 token_cost 是否在下降。

详见 `0-System/evolution-log.md`。

---

## /learn 执行协议（BRO 结构化进化）

> 进化任务"做错代价" > 30 分钟返工 → 按 BRO-PDCA 完整模式执行。
> 借鉴 Meta-Harness：进化 Agent 应自主检索完整轨迹，不依赖压缩摘要。

### 触发时机

每日 22:33 或手动输入 `/learn` 时执行。

### 执行步骤

#### Step 1: B（背景采集 — grep 原始数据，不看摘要）

```bash
# 1. 近期摩擦事件（从轨迹中提取）
grep "friction" 0-System/trajectories/*.jsonl 2>/dev/null | tail -20

# 2. 近期决策点（含 rejected 选项）
grep "decision" 0-System/trajectories/*.jsonl 2>/dev/null | tail -20

# 3. task-log 近 7 天（含 friction_skill × token_cost）
tail -20 0-System/task-log.md

# 4. evolution-log 最近 5 条（避免重复改进）
tail -30 0-System/evolution-log.md
```

#### Step 2: R（需求分析 — 从数据中提炼模式）

输出结构化分析：
- **摩擦聚类**：哪些 skill/域名反复出现？共性原因是什么？
- **成本异常**：同类任务 token_cost 有无飙升？
- **决策复盘**：有没有 rejected 选项后来被证明才是对的？
- **已做改进效果**：上轮进化的改进是否生效？

#### Step 3: O（目标 + 约束）

- **O1**：本轮改进的具体目标（如"降低 lark-cli 摩擦率"或"减少重复探索"）
- **O2**：约束（不增加 CLAUDE.md 字数 / 不改已稳定的 skill / 不引入新依赖）

#### Step 4: P+D（提出改进 + 实施）

- 每个改进标注红/黄/白 + 预期效果
- 红/黄标自主实施，白标输出候选等确认
- 实施后更新 evolution-log

#### Step 5: A（沉淀）

- 有效改进 → 提取为永久规则
- 无效改进 → revert + 记录"此方向不可行"
- 追加 RECENT_EVENTS

---

## 飞书通道确认规则

飞书收到的指令存在歧义、冲突、高风险、上下文不足时，**必须先回复确认，不直接执行**。

---

## 依赖本地化

所有外部依赖安装到项目根目录，不依赖系统 PATH 或全局安装。

---

## Session 生命周期

**每次 Session 必做**：
1. 开始时读 `0-System/RECENT_EVENTS.md`
2. 结束前追加事件到 `RECENT_EVENTS.md` + 提取原子 Item 到 `memory-items.md`

---

## 轨迹捕获（强制执行协议）

> 借鉴 Meta-Harness：完整执行轨迹是进化的核心燃料，摘要不能替代原始数据。

### 触发条件

满足任一条件即**必须**创建轨迹文件：
- 任务预计 >10 分钟
- 涉及 >5 次工具调用
- 多 Agent 协作任务
- 定时任务出现摩擦

### 执行步骤

1. **任务开始时**：创建 JSONL 文件 `0-System/trajectories/YYYY-MM-DD-HH-taskname.jsonl`
2. **写入 plan 事件**：记录任务拆解和初始方案
3. **关键决策点**：写入 decision 事件（必须包含 rejected 选项和原因）
4. **摩擦发生时**：立即写入 friction 事件（包含完整错误信息，不只是分类标签）
5. **任务结束时**：写入 result 事件（status + tokens_used）

### 写入时机

**不要攒到最后一次性写入**。每个关键节点实时追加，确保中途 session 断开也有部分轨迹。

### 与进化系统的对接

- `/learn` 进化时：先 grep 近期轨迹中的 friction 和 decision 事件，再看 task-log
- `/retro` 复盘时：统计轨迹中的 friction 分布、decision 成功率
- 进化 Agent 可自由检索 `0-System/trajectories/` 目录下的所有文件

格式详见 `0-System/trajectories/README.md`。

---

## 环境引导（Session 冷启动优化）

> 借鉴 Meta-Harness 环境引导：在 Agent 开始执行前注入环境快照，省掉 2-5 轮探索。

### 触发条件

Session 开始时，如果当前任务涉及以下场景，**自动执行环境探测**：
- 服务相关操作（启动/停止/调试）
- 部署或配置变更
- 调试排错

### 探测项目

```bash
# 1. 关键服务状态
lsof -i :18080 2>/dev/null | head -3   # mycc 后端
lsof -i :3000 2>/dev/null | head -3    # 前端开发服务器

# 2. 关键进程
ps aux | grep -E '(node|python|nginx)' | grep -v grep | head -5

# 3. Git 状态
git status --short | head -10

# 4. 最近改动
git log --oneline -3
```

### 结果注入

探测结果作为**环境快照**，在首次回复中简要汇报（1-3 行），不需要用户确认即可开始工作。

### 不触发的场景

- 简单问答
- 文档阅读/编辑
- 记忆操作
- 用户明确说了具体要做什么（无需探测）
