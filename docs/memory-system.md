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

## v3 升级（2026-03-23，借鉴 Supermemory）

### 双时间戳（temporal grounding）

每条 Item 支持两个日期：
- `[YYYY-MM-DD]` — 写入日期（原有）
- `[event:YYYY-MM-DD]` — 事件日期（新增，可选）

事件日期参与评分：已过期事件自动降权（0.05），即将发生的事件自动提权（1.0）。

### 关系版本链（relational versioning）

通过 `→updates:关键词` 标记，新 Item 自动取代同类别中的旧 Item。
引擎在注入时将被取代的条目 score 归零，只展示最新版本。

### 主动遗忘（smart forgetting）

每日 04:00 定时任务自动清理：
1. eventDate 过期 >7 天 → 删除
2. 写入 >90 天且 ★<3 → 归档到 `memory-archive.md`
3. 写入 >120 天 → 无条件归档

### 搜索升级（TF-IDF cosine）

类别模糊匹配从 Jaccard 集合交集升级为 TF-IDF 余弦相似度，对长短文本差异更鲁棒。

### 实时捕获优化

Auto-capture 冷却时间从 60s 降至 30s，提高中途记忆捕获频率。

### 多模态记忆（预留）

格式预留 `[source:image/video/camera]`，实施时机：接入外接摄像头后。

## v4 升级（2026-03-27，借鉴 TurboQuant 失真率理论）

> 理论来源：TurboQuant (arXiv:2504.19874) — 向量量化的信息论下界证明：
> 压缩 4 倍时理论最优失真 ≈ 1/256（即 99.6% 信息可保留）。
> 核心启发：**基础编码 + 残差修正** 优于完全替代；每层压缩应有明确的失真预算。

### P0: 残差版本链（替代旧 →updates 语义）

**旧方案**：`→updates:关键词` 让旧 Item score 归零，信息完全丢失。
**新方案**：基线 + 增量（Δ），类比 TurboQuant 的 `x̃ = Q_mse(x) + ||r|| · Q_qjl(r)`。

**三个标记**：
- `#base` — 基线事实，记录该主题最稳定的核心信息（低频变化）
- `→Δ:基线关键词` — 增量修正，记录相对于基线的变化部分（高频变化）
- `→supersedes:基线关键词` — 完全重写（仅当基线本身已错误/过时时使用，取代旧 →updates）

**规则**：
1. 一个主题首次写入时正常写，不需要任何标记
2. 同一主题第二次变更时，把原条目标为 `#base`，新增的写 `→Δ:基线关键词`
3. 增量（Δ）可堆叠：多次小变更各自独立记录，检索时按时间排序叠加
4. 增量堆叠 ≥3 条时，触发**重建基线**：合并所有 Δ 到新 #base，清除旧 Δ
5. `→supersedes:` 是核弹选项：旧基线 + 所有 Δ 全部 score 归零，仅当根本性变化时使用

**格式示例**：
```markdown
- ★★★ cc-remote V4：阿里云香港 FRP 中转，域名 cli4.hahaxiong.cc [2026-03-15] #base #cc-remote
- ★★ Δ 修复 WebSocket 重连超时 [2026-03-20] →Δ:cc-remote-V4 #cc-remote
- ★★ Δ deploy-user.sh 改为两步写配置（先 HTTP 再 SSL）[2026-03-26] →Δ:cc-remote-V4 #cc-remote
```

**检索行为**：
- 命中 `#base` 时，自动拉取同类别下所有 `→Δ:该基线关键词` 的条目
- 展示顺序：基线在前，Δ 按时间升序
- Δ 条目单独命中时，同样自动拉取其基线

### P1: 分层失真预算

> 信息论保证：每层压缩的失真有理论下界 D ≥ 4^{-b}。
> 我们为三层转换定义可操作的质量标准。

**Resource → Item（RECENT_EVENTS → memory-items）**：

| 必须保留（≥95%） | 允许丢弃 |
|------------------|---------|
| 决策结论（做了什么、选了什么方案） | 时间修辞（"先…然后…最后"） |
| 关键参数（端口、路径、版本号） | 中间调试过程 |
| 因果关系（为什么这样做） | 情绪表达 |
| 失败教训（踩了什么坑） | 重复确认对话 |

**检查规则**：提取 Item 时自问——"如果只看这条 Item，下次遇到同样场景能直接复用吗？" 如果不能，说明丢了关键信息。

**Item → Category（memory-items → MEMORY.md）**：

| 必须保留（≥80%） | 允许丢弃 |
|------------------|---------|
| 主题存在性（"有这个东西"） | 具体参数值 |
| 位置指针（"去哪里找"） | 实现细节 |
| 当前状态（运行中/已废弃） | 历史变更过程 |

**检查规则**：MEMORY.md 的每一行应能回答"这个主题还活着吗？详情去哪看？"

**RECENT_EVENTS 滚动清理时的失真预算**：

超过 24h 的事件在从 RECENT_EVENTS 清除前，必须确认：
1. 已提取为 memory-items（如有可复用事实）
2. 或该事件无跨会话价值（纯执行日志）

违反预算的信号：下次 session 问"上次那个 XXX 怎么配的"却找不到 → 说明 Resource→Item 转换丢了关键信息，需要补提取。

### P2: 向量语义检索（已落地）

**模型**：Qwen3-Embedding-0.6B（Ollama 本地运行，Q4 约 395MB）
**维度**：512（MRL 裁剪，从默认 1024 截取）
**索引**：`0-System/memory-vectors.json`（274 条，~1.7MB）

**混合评分策略**：
```
最终类别 = 关键词正则（确定性） + TF-IDF 模糊（+2类别） + 向量语义（+2类别）
```
- 关键词对精确参数（端口、路径、命令）更可靠
- 向量对语义泛化（"bot API" ↔ "飞书机器人"）更强
- 混合取两者长处，降级时无感回退到纯关键词

**降级机制**：Ollama 未运行 → embed() 返回 null → 跳过向量检索 → 纯 v3 逻辑

**索引更新**：
- 全量重建：`npx tsx src/scripts/rebuild-index.ts /Users/rayman.chen/mycc`
- 增量：session 结束写入新 Item 时，顺便 embed 追加到 JSON（待实现）

**依赖**：
- Ollama：`~/bin/ollama` → `/Applications/Ollama.app/Contents/Resources/ollama`
- 启动：`ollama serve`（后台）
- 模型：`ollama pull qwen3-embedding:0.6b`

## 归档

- **周末**：`/retro` 生成周记，归档到 `5-Archive/周记/`
