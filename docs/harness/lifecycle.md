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
Task Execution (task-log)
     ↓
insights 摩擦提取（每3天 09:00）
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

详见 `0-System/evolution-log.md`。

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

## 轨迹捕获

任务 >10 分钟或涉及多工具调用时，记录执行轨迹到 `0-System/trajectories/`。
详见 `0-System/trajectories/README.md`。
