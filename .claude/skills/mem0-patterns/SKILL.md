---
name: mem0-patterns
description: mem0 记忆架构模式 - 基于 mem0ai/mem0(★48.9k) 的 Universal Memory Layer 设计理念，用于构建和优化 AI Agent 的记忆系统。触发词："记忆优化"、"mem0"、"memory layer"
---

# mem0 记忆架构模式

> 参考项目：mem0ai/mem0 ★48.9k — Universal memory layer for AI Agents

## 核心理念：四种记忆类型

mem0 将 Agent 记忆分为四类，这是其能力远超简单 RAG 的关键：

| 类型 | 定义 | cc 的对应 |
|------|------|----------|
| **语义记忆** (Semantic) | 关于世界的事实、知识 | `memory-items.md` 中的 `[技术/xxx]` |
| **情节记忆** (Episodic) | 过去的具体经历、事件 | `RECENT_EVENTS.md` |
| **程序性记忆** (Procedural) | 如何做事的方法、流程 | `memory-items.md` 中 `[程序性/方法论]`（待建立） |
| **偏好记忆** (Preferences) | 用户/Agent 的偏好风格 | `memory-items.md` 中的 `[偏好/xxx]` |

## mem0 的记忆管理规则

### 写入时（session 结束前）
1. **提取**：从对话中提取原子事实
2. **去重**：检查是否已有同类 item，更新而不是追加
3. **分类**：按上面四种类型归类
4. **优先级**：频繁使用的 item 优先级上升（★★★ > ★★ > ★）

### 读取时（session 开始时）
1. 先读优先级最高的 item（★★★）
2. 按任务类型筛选相关记忆类别
3. 情节记忆（RECENT_EVENTS）只读最近 24h

### 过期处理
- 超过 30 天未使用的 item → 降级或标 `[已废弃]`
- 被修正的 item → 立即更新，不保留旧版本
- 临时状态（如 pairCode、tunnelUrl）→ 不写入长期记忆

## cc 的实施方案

### 优先级标注规范（借鉴 mem0 的 score 系统）

在 `memory-items.md` 中，高价值 item 加优先级标注：

```
- ★★★ 飞书签名算法：HMAC-SHA256...（高频使用，核心知识）
- ★★  黄金实时价主源：goldprice.org...（中频，每天用）
- ★   ai-news-radar 数据路径：...（低频，偶尔查）
```

### 程序性记忆类别

在 `memory-items.md` 增加 `[程序性/方法论]` 类别：

```markdown
## [程序性/方法论]
- ★★★ 飞书发送失败排查步骤：1) 检查 secret 2) 验证签名算法 3) 查 config.json
- ★★★ github-radar 执行流程：Step1 python 抓数据 → Step2 cc 分析判断 → Step3 send.js 发飞书
- ★★  数据源故障处理：主源失败 → 等待1s → 切备用源 → 记录到 RECENT_EVENTS
```

## 与 cc 现有三层架构的映射

```
mem0 架构          cc 现有实现
---------          -----------
Vector Store    ←→  memory-items.md (原子 Item，按类别检索)
Graph Memory    ←→  MEMORY.md (关系索引，决策记录)
Event History   ←→  RECENT_EVENTS.md (24h 流水账)
```

## 关键差异（cc 可以改进的地方）

1. **mem0 有语义搜索，cc 是关键词手动查** → 用类别标签 + 优先级★来弥补
2. **mem0 自动去重更新，cc 靠 cc 手动维护** → session 结束时主动检查重复
3. **mem0 有 score 衰减，cc 没有** → 用 `[已废弃]` 标签手动衰减

## 参考链接

- GitHub: mem0ai/mem0（Universal memory layer for AI Agents）
- 核心论文思路：Four memory types in cognitive AI systems
