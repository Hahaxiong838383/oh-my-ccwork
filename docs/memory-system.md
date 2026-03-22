# 记忆系统详细说明

> 从 CLAUDE.md 下沉，详细描述 cc 的三层记忆架构。

## 短期记忆（自动注入）

每次对话时，通过 hooks 自动注入：
- `0-System/status.md`：当前状态快照、今日焦点
- 配置位置：`.claude/settings.local.json`

## 滚动事件流（24h，EvoMap Memory Bridge）

**Session 开始时必读**：
- `0-System/RECENT_EVENTS.md`：最近 24h 重要事件（上次做了什么、当前状态）

**关键词召回（方案C，2026-03-09 起）**：
- 读取用户第一条消息的关键词
- 按关键词匹配 `memory-items.md` 的类别，只注入命中的 `[project/*]` 类别
- `[user/*]` 类别（偏好/方法论/全局规则）**始终注入**，不受关键词过滤
- 无命中时：只注入全部 `[user/*]`，跳过所有 `[project/*]`
- 映射示例：
  - 飞书/机器人/卡片/消息/通道 → `[project/技术-飞书]` + `[project/技术-飞书多通道]`
  - 黄金/金价/数据/采集 → `[project/技术-数据]` + `[project/技术-RSS采集]`
  - Bug/错误/修复/报错 → `[project/Bug-Fix]` + `[project/Bug-Fix-已知]` + `[project/Bug-Fix-MCP]`
  - 知识库/Wiki/FUTURUS/飞书文档 → `[project/FUTURUS知识库]`
  - 配置/后端/端口/mycc/启动 → `[project/配置-mycc后端]`
  - 路径/文件/脚本 → `[project/路径-关键文件]`
  - 产品/需求/PRD/功能设计/做一个/想法/用户/app → `[project/产品-prd]`

**Session 结束前必写（两步）**：
1. 追加本次操作到 `RECENT_EVENTS.md`（流水账，格式：`- \`HH:MM\` 事件描述`）
2. 提取原子 Item 到 `0-System/memory-items.md`（结构化事实，只写新发现/变更）
   - Item 格式：在对应命名空间类别下追加一行 `- 简洁的可复用事实`
   - 命名空间：`[user/*]`（跨项目通用）或 `[project/*]`（mycc 专属）
   - 叶子原则：每条 Item 只写一个独立事实，不含推论或多个并列事实
   - 原则：每条 Item 独立可检索，过期的直接删除或标 `[已废弃]`

## 持久记忆

三层结构（参考 memU 的 Resource → Item → Category 设计）：
- `0-System/RECENT_EVENTS.md`：Resource 层，24h 滚动流水账
- `0-System/memory-items.md`：**Item 层**，原子化可检索事实
- `0-System/MEMORY.md`：Category 层，高层索引与重要决策汇总
- `0-System/about-me/`：川哥的完整画像、经历、偏好、价值观等

## 归档

- **周末**：`/retro` 生成周记，归档到 `5-Archive/周记/`
