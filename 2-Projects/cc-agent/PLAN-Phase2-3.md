# cc-agent Phase 2 + Phase 3 详细执行规划

> 基于 Phase 1 已部署的基础设施，推进自进化闭环和知识自增长
> 创建：2026-04-11

---

## Phase 1 完成状态（基线）

| 组件 | 状态 | 数据量 |
|------|------|--------|
| PostgreSQL + PGroonga :5433 | Running | 10 张表 |
| Wiki MCP（5 工具） | Ready | 29 文档 |
| Skill MCP（8 工具） | Ready，E2E 通过 | 2 条轨迹（测试），2 个 skill draft |
| Gateway MCP（3 工具） | Ready | Gemini Flash + MiniMax M2.7 |
| 微信通道 | Running | 三层路由（simple/reasoning/hard） |
| .claude/skills/ | 42 个 skill 文件 | 未同步到 PG |

**核心缺口**：
- 轨迹收集**没有自动触发**（只有手动测试的 2 条）
- 42 个已有 skill **未导入** skill_registry
- 知识库**无自动增长**（只有一次性迁移的 29 文档）
- agent_outbox 有 1 条 pending 通知**没有消费者**
- 微信入库的文章**未实际测试**

---

## Phase 2：自进化闭环落地（预计 2 周）

### 目标
让 cc 在日常工作中**自动**积累轨迹 → 沉淀技能 → 增长知识，形成可观测的进化循环。

---

### 2.1 轨迹自动记录（P0，Day 1-3）

**现状**：skill_mcp 的 8 个 MCP 工具已 ready，但 cc 从不主动调用。
**目标**：cc 在普通档/完整档任务中自动记录轨迹。

#### 方案 A：CLAUDE.md 行为规则（轻量，推荐先行）

在 CLAUDE.md 的「行为规则」里新增：

```markdown
## 轨迹记录（自动触发）

**触发条件**：任务复杂度 ≥ 普通档（预估 >30min 或涉及多步操作）

**流程**：
1. 任务开始 → `trajectory_open(session_id, title, description)`
2. 每个关键步骤 → `trajectory_step(...)`（不需要每个小操作都记，记关键里程碑）
3. 做了重要决策 → `trajectory_decision(...)`
4. 遇到错误/摩擦 → `trajectory_friction(...)`
5. 任务结束 → `trajectory_close(outcome, summary, auto_draft=false)`

**不记录**：简洁档（日常问答、简单查询）
**auto_draft 默认关**：前 2 周只积累数据，不自动生成 Skill
```

#### 方案 B：Claude Code Hooks 自动注入（重量，后续考虑）

通过 `settings.json` 的 hooks，在每次 tool call 后自动追加 trajectory_step。
- 优点：完全自动，无需 cc 主动调用
- 缺点：噪音大（每个 Read/Edit 都记录），需要过滤逻辑
- **建议 Phase 3 再考虑**

#### 验收标准
- [ ] CLAUDE.md 规则写入后，cc 在下一次普通档任务中自动开启轨迹
- [ ] 一周内积累 10+ 条真实轨迹
- [ ] 轨迹包含完整的 steps/decisions/frictions

---

### 2.2 已有 Skills 导入（P0，Day 1）

**现状**：42 个 .claude/skills/ 文件未同步到 skill_registry。
**目标**：`skill_search` 能检索所有已有技能。

#### 执行步骤
1. 运行 `catalog_sync.py`（已写好），将 42 个 skill 同步到 PG
2. 验证 `skill_search("部署")` 能返回相关 skill
3. 设置每日 cron 定期同步（捕获新增/修改的 skill）

#### 验收标准
- [ ] skill_registry 中有 42+ 条 `source_type='verified_fs'` 记录
- [ ] `skill_search` 全文搜索可用

---

### 2.3 微信 → Wiki 入库实测（P0，Day 2-3）

**现状**：代码已写好（wiki-client.ts + gemini-gateway.ts 的 handleArticle），但未实际测试。
**目标**：转发公众号文章到微信 → 自动入库 + 摘要 + 关联。

#### 测试用例
1. 转发一篇短文（<1000 字）→ 验证入库 + 摘要
2. 转发一篇长文（>3000 字）→ 验证分块 + 摘要
3. 转发一个 URL → 验证 URL 识别（当前只识别长文本，URL 需要加 fetch 逻辑）
4. 之后问"之前那篇文章说了什么"→ 验证知识增强回复

#### URL 文章抓取（需新增）
当前 `isArticle()` 只检测长文本，不处理 URL。需要加：
```typescript
// 检测到 URL → fetch 内容 → 转为文本 → 走 handleArticle
if (/https?:\/\/\S{10,}/.test(text)) {
  const content = await fetchUrl(text);  // 新增：抓取网页内容
  return await this.handleArticle(userId, content);
}
```

#### 验收标准
- [ ] 微信转发文章 → 收到"已收录+摘要+关联"回复
- [ ] 后续提问能检索到入库的文章
- [ ] URL 也能自动抓取入库

---

### 2.4 agent_outbox 微信推送（P1，Day 4-5）

**现状**：outbox 表有 pending 消息，但没有消费者。
**目标**：Skill draft 生成后自动通过微信通知用户。

#### 方案
写一个简单的 outbox worker（Python 脚本，cron 每分钟跑一次）：
```
1. 查询 agent_outbox WHERE status='pending'
2. 对每条消息，通过 cc2wechat-reply CLI 发送到微信
3. 更新 status='sent'
```

#### 文件
- `cc-agent/scripts/outbox_worker.py`：消费 outbox → 调 cc2wechat-reply
- cron 配置：每分钟运行

#### 验收标准
- [ ] Skill draft 生成后 → 微信自动收到通知
- [ ] 通知内容：标题 + 路径 + 扫描状态

---

### 2.5 知识库自动采集管线（P1，Day 5-8）

**现状**：知识库只有一次性迁移的 29 文档，无自增长。
**目标**：每日自动采集外部信息 → LLM 编译 → 入库。

#### 采集源（复用现有 skill 逻辑）

| 源 | 现有 skill | 复用方式 | 频率 |
|----|-----------|---------|------|
| AI 技术博客 RSS | `/collect` | 提取 RSS fetch 逻辑 | 每天 08:00 |
| GitHub 热门项目 | `/github-radar` | 复用抓取+分析 | 每天 09:00 |
| ArXiv 论文 | `/theory-radar` | 复用抓取+摘要 | 每天 10:00 |
| 微信转发文章 | 微信通道 | 已有（2.3） | 实时 |

#### 采集管线架构
```
scripts/daily_ingest.py（cron 驱动）
  │
  ├─ fetch_rss(feeds) → 新文章列表
  ├─ fetch_github_trending() → 项目列表
  └─ fetch_arxiv(topics) → 论文列表
  │
  ▼
对每个新 item：
  1. 存入 /sources/（trust=verified，原始素材）
  2. 分块 → document_chunks
  3. 调 Gateway LLM（Gemini Flash）生成摘要
  4. 存入 /wiki/auto/daily/{date}/{slug}（trust=draft）
  5. 追加到 /wiki/auto/daily-digest-{date}.md（当日汇总页）
  │
  ▼
完成后写 agent_outbox → 微信通知
  "今日采集：12 篇文章，3 个 GitHub 项目，2 篇论文"
```

#### auto/ 目录 = draft 隔离区
- 自动采集的内容进 `/wiki/auto/`，`trust_level='draft'`
- 默认搜索**不包含** draft（需 `include_drafts=true` 才可见）
- 用户在微信回复"确认 {path}"可以将 draft 提升为 verified

#### 验收标准
- [ ] `daily_ingest.py` 能从 RSS 抓取并入库
- [ ] 每日汇总页生成
- [ ] 微信收到采集通知
- [ ] draft 内容搜索时不干扰正常结果

---

### 2.6 模型稳定性提升（P1，Day 3-5）

**现状**：Gemini 中转 ~40% 500 率；MiniMax highspeed 未验证。

#### 行动项
1. **排查 Gemini 中转 500**：确认是代理问题还是中转服务本身
2. **验证 MiniMax M2.7-highspeed 模型名**：可能需要确认为 `MiniMax-M2.7-highspeed` 还是其他
3. **增加更多 provider**：考虑接入 DeepSeek（国内直连稳定，便宜）
4. **模型用量统计启用**：Gateway 的 `model_usage` 表开始积累数据，7 天后输出成本分析

#### 验收标准
- [ ] 微信对话成功率 >95%（不降级到 Claude）
- [ ] 7 天 model_usage 数据可查

---

### 2.7 Skill Draft 生成启用（P2，Day 9-12）

**前提**：2.1 轨迹积累 2 周后。
**目标**：复杂任务完成后自动提议生成 Skill Draft。

#### 分步启用
1. **手动触发**（Day 9）：cc 主动判断"这个任务值得沉淀"时调用 `skill_draft_generate(tid)`
2. **半自动**（Day 11）：`trajectory_close(auto_draft=true)` 在 eligible 时自动生成，但不自动发微信确认
3. **全自动**（Phase 3）：生成 → 微信通知 → 用户确认 → 落盘 .claude/skills/

#### 验收标准
- [ ] 从真实轨迹生成的 Skill Draft 质量可接受
- [ ] Draft 安全扫描正常工作
- [ ] Draft 路径正确（/wiki/skill-drafts/）

---

### Phase 2 里程碑汇总

| 编号 | 里程碑 | 依赖 | Day |
|------|--------|------|-----|
| M1 | CLAUDE.md 轨迹规则 + skills 同步 | 无 | 1 |
| M2 | 微信入库实测通过 | 无 | 2-3 |
| M3 | 模型稳定性 >95% | 无 | 3-5 |
| M4 | outbox → 微信推送 | M2 | 4-5 |
| M5 | 自动采集管线 v1（RSS） | M3 | 5-8 |
| M6 | 10+ 真实轨迹积累 | M1 | Day 7-14（自然积累） |
| M7 | Skill Draft 手动生成 | M6 | 9-12 |
| M8 | 闭环验证：轨迹→Draft→通知 | M4+M7 | 12-14 |

---

## Phase 3：深度集成 + 自动化升级（预计 3-4 周）

### 目标
从"人驱动的半自动系统"升级为"自运转的进化系统"。

---

### 3.1 Skill 审批流（微信交互）

**目标**：Draft 生成后，用户在微信上直接审批。

```
cc（微信）: "发现可复用模式，已生成 Skill 草稿：
  标题：NAS Docker 服务部署
  路径：/wiki/skill-drafts/nas-docker-deploy
  扫描：pass
  回复 '确认' 启用，'查看' 看详情，'拒绝' 丢弃"

用户（微信）: "确认"

cc: "已启用！Skill 已移动到 .claude/skills/nas-docker-deploy/"
```

#### 实现
1. 命令网关新增 `/approve {slug}`、`/reject {slug}`、`/view {slug}` 命令
2. approve → 从 /wiki/skill-drafts/ 读取内容 → 写入 .claude/skills/ → 更新 skill_registry status='active'
3. reject → 更新 skill_registry status='rejected'

---

### 3.2 轨迹自动化升级（Hooks 注入）

**目标**：不依赖 cc 主动调用，通过 Claude Code hooks 自动记录。

#### 方案
```json
// settings.json hooks
{
  "hooks": {
    "PostToolUse": [{
      "command": "python3 /path/to/trajectory_hook.py $TOOL_NAME $TOOL_INPUT_FILE",
      "event": "PostToolUse",
      "description": "自动记录轨迹步骤"
    }]
  }
}
```

`trajectory_hook.py` 逻辑：
- 维护当前活跃 trajectory_id（从文件读取）
- 过滤噪音：只记录 Bash/Write/Edit/Agent 等有副作用的工具
- 自动追加 trajectory_step

#### 风险
- Hook 执行延迟可能影响 cc 响应速度 → 异步写入，不阻塞
- 噪音过多 → 白名单过滤（只记关键工具）

---

### 3.3 知识库健康检查（Lint）

**目标**：定期扫描 wiki，发现矛盾/孤页/过期内容。

#### Lint 规则
1. **孤页检测**：wiki 页面没有被任何其他页面引用
2. **过期检测**：created_at > 90 天 且 未被搜索命中过
3. **矛盾检测**：同一概念在不同页面的描述不一致（需 LLM 辅助判断）
4. **质量检测**：内容 < 100 字的页面标记为低质量

#### 执行
- `scripts/wiki_lint.py`：每周 cron 运行
- 输出 lint 报告到 `/wiki/auto/lint-report-{date}.md`
- 通知到微信

---

### 3.4 向量检索（语义搜索）

**现状**：PGroonga 只做关键词全文搜索。
**目标**：加 embedding 向量搜索，提升语义匹配准确率。

#### 方案
1. 用 PG 的 `pgvector` 扩展（不新增服务）
2. 文档写入时，调 Gateway LLM 生成 embedding → 存入 `document_chunks.embedding` 列
3. 搜索时：关键词搜索（PGroonga）+ 向量搜索（pgvector）→ RRF 融合排序

#### 依赖
- 需要 embedding 模型（MiniMax 或 OpenAI 的 embedding API）
- pgvector 安装（Docker 镜像可能需要自编译）

---

### 3.5 多设备 Wiki 同步

**现状**：知识库只在 NAS 本地。
**目标**：Mac 主力机也能访问同一个知识库。

#### 方案
- PG over SSH tunnel：Mac → SSH → NAS:5433
- Mac 端的 wiki_mcp 连接 tunnel 后的 PG
- 或者：NAS PG 开 tailscale 内网 IP 访问

---

### 3.6 知识编译质量升级

**现状**：采集内容直接存入，无深度编译。
**目标**：新素材入库时，LLM 自动与已有知识交叉引用、生成概念页。

#### 编译流程升级
```
新素材 → LLM 提取关键概念
  → 搜索已有 wiki 中的相关页面
  → 对每个概念：
     ├─ 已有页面 → str_replace 追加新信息
     └─ 新概念 → 创建概念页
  → 更新交叉引用链接
  → 追加 /wiki/log.md
```

#### LLM 选择
- 概念提取：Gemini Flash（快速）
- 交叉引用和编译：MiniMax M2.7（推理强）

---

### 3.7 成本监控仪表盘

**目标**：可视化模型用量和成本。

#### 实现
- `scripts/usage_report.py`：每日生成用量报告
- 输出：按模型/任务类型/天 的 token 消耗和费用
- 微信每周推送一次成本摘要

---

### 3.8 Skill 效果追踪

**目标**：量化每个 Skill 的价值。

#### 指标
- 使用次数 / 成功率（从 trajectory_steps 中提取 tool_name 匹配 skill 名）
- 平均节省步骤数（与无 skill 时的轨迹对比）
- 最近一次使用时间（冷门 skill 标记归档）

#### 数据源
- trajectory_steps 中的 tool_name → 关联 skill_registry
- trajectory_frictions → 某个 skill 是否反复产生摩擦

---

### Phase 3 里程碑汇总

| 编号 | 里程碑 | 依赖 | 周 |
|------|--------|------|-----|
| M9 | 微信 Skill 审批流 | Phase 2 M7 | Week 1 |
| M10 | 轨迹 Hooks 自动化 | Phase 2 M6 | Week 1-2 |
| M11 | Wiki Lint v1 | Phase 2 M5 | Week 2 |
| M12 | 向量检索（pgvector） | Phase 2 M5 | Week 2-3 |
| M13 | 知识编译升级 | M12 | Week 3 |
| M14 | 多设备同步 | 无 | Week 2（独立） |
| M15 | 成本监控 + 周报 | Phase 2 M3 | Week 1（独立） |
| M16 | Skill 效果追踪 | Phase 2 M6+M7 | Week 3-4 |

---

## 风险矩阵

| 风险 | 影响 | 概率 | 缓解 |
|------|------|------|------|
| 轨迹噪音过多 | PG 膨胀、skill draft 质量差 | 中 | Phase 2 先手动记录，积累经验再自动化 |
| 中转持续不稳定 | 微信体验差 | 高 | 接入更多 provider（DeepSeek） |
| NAS 磁盘不够 | 自动采集跑一段后撑满 | 中 | 设采集量上限（30条/天），定期清理 draft |
| Hook 延迟影响体验 | cc 响应变慢 | 低 | 异步写入，不阻塞主流程 |
| 向量搜索 PG 负载 | 搜索变慢 | 低 | pgvector 用 IVFFlat 索引，限制 top-k |
| Skill Draft 质量差 | 用户失去信任不再审批 | 中 | 先用 MiniMax 推理模型提升质量，人工审批兜底 |

---

## 成本预估

| 阶段 | 额外 LLM 调用 | 估算费用/天 |
|------|-------------|------------|
| Phase 2（轨迹+采集） | 摘要 ~20 次 + 编译 ~10 次 | Gemini Flash ~$0.02 |
| Phase 3（向量+编译+lint） | embedding ~50 次 + 编译 ~20 次 + lint ~5 次 | ~$0.05 |
| **合计增量** | | **< $0.1/天** |

---

## 优先级排序建议

```
Week 1-2（立即）:
  ✅ 2.1 轨迹规则 + 2.2 skills 同步（Day 1，零开发）
  ✅ 2.3 微信入库实测（Day 2-3）
  ✅ 2.6 模型稳定性（Day 3-5）
  ✅ 2.4 outbox 推送（Day 4-5）

Week 2-3（知识增长）:
  📦 2.5 自动采集管线
  📦 3.5 成本监控

Week 3-4（自进化闭环）:
  🔄 2.7 Skill Draft 生成
  🔄 3.1 微信 Skill 审批流
  
Week 4-6（深度升级）:
  🚀 3.2 Hooks 自动化
  🚀 3.3 Wiki Lint
  🚀 3.4 向量检索
  🚀 3.6 知识编译升级
```
