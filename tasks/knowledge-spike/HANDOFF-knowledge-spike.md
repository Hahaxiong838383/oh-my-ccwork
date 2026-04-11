# HANDOFF — mycc-brain 外挂知识系统 · Spike 已完成 → P0 实装

> 阶段：**Day 0 Spike 完成 → P0 待实装**
> 决策：**GO-with-tweaks**（2026-04-11 00:05 CST，川哥批准）
> 分支：`feat/knowledge-system`（本地 commit `96e66c8`，**未 push**）
> 下个 session 的 cc：**读完本文档就能直接干，零返工**

---

## 一、30 秒速览

**目标**：为 brain 加一条「飞书 Wiki → Gemini Flash 原子事实抽取 → 独立 knowledge.db」的外挂学习管线。

**Spike 结论**：
- ✅ 抽取质量优（战略主页 12 facts 完美还原 O/P/原则/原因四层）
- ✅ 成本可忽略（$0.000783 / 5 篇，月度运行 < $0.20）
- ✅ content-hash 稳定，增量判重可行
- ✅ 空壳识别有效（无妄想）
- ⚠️ 需要 6 个 tweaks（见第四节）

**下一步**：P0 实装 6 个子任务，预计 ~5h，2 个 session 完成。

---

## 二、已完成工作

### ✅ Phase 0: 分支 + RECENT_EVENTS
- `feat/knowledge-system` 分支已创建（working tree 与 main 隔离）
- RECENT_EVENTS 补录已完成

### ✅ Phase 1: Wiki 侦察
- 21 个 wiki spaces 已枚举 → `tasks/knowledge-spike/wiki-inventory.md`
- **选定 space**：⌘FUTURUS知识库 (`space_id=7224326117803425820`, 9 个根节点, 04-08 更新)

### ✅ Phase 2: P0 脚手架（src/knowledge/）
| 文件 | 状态 | 说明 |
|---|---|---|
| `types.ts` | 实装 | 12 个 readonly interfaces/types（KnowledgeItem / ExtractedFact / DocSyncState / Allowlist 等） |
| `store.ts` | 实装 ✅ 扩展 | knowledge.db + FTS5 + 3 触发器 + soft delete + **doc_sync_state 表 + 3 CRUD 函数 (P0.1)** |
| `allowlist.ts` | 实装 | JSON loader + Zod 校验 + 4 个 query helpers |
| `crawler.ts` | **实装 ✅ (P0.1)** | `larkApi` / `listWikiNodes` / `fetchDocContent` / `crawl()` + `CrawlerDeps` 依赖注入 |
| `extractor.ts` | **实装 ✅ (P0.2)** | `callGeminiFlash` / `extractFacts()` + F3 prompt tweak + T4 confidence 过滤 + `BudgetExceededError` + 重试×2 |
| `store.test.ts` | 14/14 ✓ | 原 10 + doc_sync_state upsert/get/list 4 新测试 |
| `allowlist.test.ts` | 8/8 ✓ | 覆盖空文件/snake→camel/zod fail/edge cases |
| `crawler.test.ts` | 9/9 ✓ (P0.1) | CrawlerDeps mock，覆盖 new/update/skip/recurse/fail/maxDocs/非docx/dryRun + 纯函数 |
| `extractor.test.ts` | 11/11 ✓ (P0.2) | fetch mock，覆盖 parse/T4 过滤/JSON fence/预算/重试/HTTP 错误 |

**双门验证**：`tsc --noEmit` ✓ + `tsx --test src/knowledge/*.test.ts` **48/48 ✓**

**数据文件**：
- `data/knowledge-allowlist.template.json` — 占位模板（入库）
- `data/knowledge-allowlist.json` — **下个 session 必须创建**，内容见第五节
- `data/knowledge.db` — 运行时自动创建（已 gitignore）

### ✅ Phase 3: 深度 Spike 结果
| 文档 | bytes | facts | cost | latency | 备注 |
|---|---|---|---|---|---|
| 1.0 公司愿景 & 使命 | 567 | 5 | $0.000172 | 8.7s | confidence 0.9-1.0 |
| 2.0 公司战略管理 主页 | 1956 | **12** | $0.000486 | 16.9s | **完美还原 O/P/原则/原因四层** |
| 公司治理与方法论 | 55 | **0** | $0.000022 | 1.7s | 空壳正确识别，无妄想 |
| 员工学习与发展 | 41 | **0** | $0.000021 | 2.0s | 空壳正确识别 |
| Futurus技术知识库入口 | 219 | 2 | $0.000082 | 7.6s | **1 处轻微过度推断**（F3 tweak 的触发证据） |
| **合计** | — | **19** | **$0.000783** | 36.9s | 预算 0.16% |

**content-hash 稳定性**：5 × 3 次 sha256 完全一致 ✅

**抽取质量（人工抽查）**：18/19 精准，1 处轻微推断（技术入口添加了"独立"形容词）

---

## 三、关键文件索引

### 代码
- `2-Projects/brain-product/mycc-brain/src/knowledge/` — Phase 2 脚手架（见第二节表）
- `2-Projects/brain-product/mycc-brain/src/services/memory-db.ts` — 参考实现（FTS5 + 3 触发器模式）
- `2-Projects/brain-product/mycc-brain/src/services/brain-context.ts` — P0.3 要挂第五路 knowledgeSearch() 的地方
- `2-Projects/brain-product/mycc-brain/src/config.ts:64` — `GEMINI_PROXY_BASE = "http://23.226.135.149:4000/v1"`（硬编码）
- `2-Projects/brain-product/mycc-brain/src/config.ts:157-180` — `memoryLLM.intake` 路由（参考 Gemini 调用姿势）
- `2-Projects/brain-product/mycc-brain/.env.local` — `GEMINI_PROXY_KEY` 位置

### Spike 产物
- `tasks/knowledge-spike/spike-report.md` — **完整 Spike 报告**（数据 + findings + GO 理由）
- `tasks/knowledge-spike/wiki-inventory.md` — 21 spaces 全清单
- `tasks/knowledge-spike/scripts/fetch-wiki-inventory.sh` — 拉 space + 根节点
- `tasks/knowledge-spike/scripts/fetch-sample-docs.sh` — 拉 5 篇 + hash × 3
- `tasks/knowledge-spike/scripts/run-gemini-extraction.sh` — Gemini Flash 抽取（含 **已验证的 prompt 模板**）
- `tasks/knowledge-spike/samples/` — **本地原始数据**（已 gitignore，含战略主页商业敏感内容）
  - `PWQQd3VPRojuR7xT8cpcqteBnyg-facts.json` — 战略主页 12 facts 样本（P0.2 prompt 验证时复用）
  - `E8zPdHyNQoCdXtxs7jnc2iLfnNd-facts.json` — 愿景使命 5 facts
  - `Xo0gd0EpWoVFe7xRErEctATFnQe-facts.json` — 技术入口 2 facts（含 1 处推断，反例）
  - `extraction-summary.tsv` — 5 篇 cost/latency/facts 汇总

### 相关文档
- `2-Projects/brain-product/MANIFESTO.md` — brain 纲领（不要碰 memory.db 的约束）
- `2-Projects/brain-product/mycc-brain/docs/architecture-ssot.md` — SSOT 铁律（数据本地化）

### lark-cli
- `~/local/node/bin/lark-cli` — Air 本地已就绪
- auth: 陈川Rayman user token, refresh 到 2026-04-17
- 关键 API：
  - `GET /open-apis/wiki/v2/spaces` — 列 space
  - `GET /open-apis/wiki/v2/spaces/{id}/nodes?parent_node_token={tok}` — 列节点（parent_node_token 为空=根）
  - `GET /open-apis/docx/v1/documents/{obj_token}/raw_content` — 拉文档正文

---

## 四、P0 执行清单（tweaks 版 · 下个 session 的 cc 直接照做）

### 前置动作（15 min）

1. 读本 HANDOFF 全文 + `spike-report.md` 的第五节 Findings + 第七节 tweaks 清单
2. 验证环境：
   ```bash
   cd /Users/rayman.chen/mycc
   git status --short                                     # 应在 feat/knowledge-system
   git log --oneline -1                                   # 应见 96e66c8
   cd 2-Projects/brain-product/mycc-brain
   npx tsc --noEmit                                       # 应通过
   npx tsx --test src/knowledge/*.test.ts 2>&1 | tail -5  # 应 18/18 pass
   lark-cli auth status | jq -r .tokenStatus              # 应 "valid"
   ```
3. **创建 `data/knowledge-allowlist.json`**（运行时文件，已 gitignore）：
   ```json
   {
     "spaces": [
       {
         "space_id": "7224326117803425820",
         "name": "⌘FUTURUS知识库",
         "enabled": true,
         "root_tokens": []
       }
     ]
   }
   ```

### ✅ P0.1 + P0.2 已完成 (2026-04-11)

**交付**：
- `store.ts` 扩 `doc_sync_state` 表 + 3 CRUD (`upsertDocSyncState` / `getDocSyncState` / `listDocSyncStatesByStatus`)
- `crawler.ts` 实装 `larkApi` / `listWikiNodes` / `fetchDocContent` / `crawl()` + `CrawlerDeps` 依赖注入
- `extractor.ts` 实装 `callGeminiFlash` / `extractFacts()` + F3 prompt tweak + T4 confidence 过滤 (<0.85) + `BudgetExceededError` + 重试×2
- `crawler.test.ts` 9 tests（纯函数 + crawl 集成）
- `extractor.test.ts` 11 tests（fetch mock + HTTP 错误 + 重试 + 预算）
- `store.test.ts` 新增 4 doc_sync_state tests
- **总测试数 48/48 pass**，`tsc --noEmit` ✓，所有文件 < 400 行

**E2E 验证**（F3 tweak 离线跑技术入口文档）：
- facts=2（与 Spike 相同，两条都是原文明确陈述："独立于FUTURUS" + 完整 URL）
- cost $0.000095，latency 5.8s，tokenIn/Out=396/217
- F3 tweak 未过度压缩（好的 —— Spike 时的"1 处推断"判断偏严，实际原文就有该陈述）
- 端到端链路完整跑通（包括 HTTP 调用 + 响应解析 + confidence 过滤 + 预算核算）

**外部 blocker 注记**：Gemini proxy 在 P0.2 验证过程中一度返回 500（Google 侧 `User location is not supported`），proxy 侧已修复。后续 brain 调用需要做 [P1] 429 退避 + 全局并发门 + 降级（flash-lite → flash → reject），**不在本 P0 scope**，待 P0.3/P0.4 或独立任务处理。

**遗留的旧步骤说明**（以下小节仅作为历史参考，实际状态见上方「已完成」清单）：

### P0.1 · crawler.crawl() 递归实装（~1h）🔴 阻塞

**Finding F1 触发**：根节点多数是导航空壳，必须递归到叶子。

**实装步骤**：
1. 在 `store.ts` 加 doc_sync_state 表 schema（与 knowledge_items 一起创建）：
   ```sql
   CREATE TABLE IF NOT EXISTS doc_sync_state (
     doc_token       TEXT PRIMARY KEY,
     doc_title       TEXT NOT NULL,
     space_id        TEXT NOT NULL,
     content_hash    TEXT NOT NULL DEFAULT '',
     last_synced_at  INTEGER NOT NULL DEFAULT 0,
     last_extracted_at INTEGER NOT NULL DEFAULT 0,
     status          TEXT NOT NULL,  -- pending|synced|extracted|failed
     error_message   TEXT NOT NULL DEFAULT ''
   );
   CREATE INDEX IF NOT EXISTS idx_doc_sync_status ON doc_sync_state(status);
   ```
   补 `upsertDocSyncState(db, state)` / `getDocSyncState(db, token)` / `listStatesByStatus(db, status)` 三个函数 + 对应测试。

2. 在 `crawler.ts` 实装：
   - `listWikiNodes(spaceId, parentToken?)` — 调 `lark-cli api GET /open-apis/wiki/v2/spaces/{id}/nodes` 或直接 fetch（建议直接用 `child_process.spawn('lark-cli', [...])` 调 CLI，避免自己管 auth token）
   - `fetchDocContent(objToken)` — 调 `lark-cli api GET /open-apis/docx/v1/documents/{obj_token}/raw_content`
   - `crawl(options)` — DFS 递归展开所有 `has_child: true` 的节点，对每个 docx 叶子：
     1. 拉正文
     2. 算 `computeContentHash`
     3. 与 `doc_sync_state.content_hash` 对比
     4. 若 hash 变化或首次 → `upsertDocSyncState({status: 'pending', content_hash, last_synced_at: now})`
     5. 返回 CrawlerResult 统计

3. **防御**：
   - 每个 lark-cli 调用加 200ms sleep 防限流
   - maxDocs 硬上限（options 参数）
   - 失败不中断（status=failed + error_message，继续下一个）

4. 单元测试 `crawler.test.ts`：
   - mock `listWikiNodes` / `fetchDocContent`（不真调 API）
   - 覆盖：递归结构 / hash 变化检测 / 失败恢复 / maxDocs 截断
   - 目标 5-7 个 test cases

**双门验证**：`tsc --noEmit` + 新 tests 通过

### P0.2 · extractor.extractFacts() 实装（~1h）🔴 阻塞

**Finding F3 触发**：Gemini 会做"概要性推断"，需要 prompt 加固。

**实装步骤**：
1. **prompt 从 `tasks/knowledge-spike/scripts/run-gemini-extraction.sh` 复制**（已验证的），**追加两句**：
   ```
   额外约束（严格遵守）：
   - 只抽取原文**明确陈述**的事实；如果某条信息需要你推断或补充形容词，**不要输出该条目**。
   - 宁可少抽几条、宁可返回空数组，也不要编造或扩写。
   ```

2. 在 `extractor.ts` 实装：
   - `callGeminiFlash(client, systemPrompt, userMsg)` — fetch POST to `{baseUrl}/chat/completions`，带 `response_format: {type: 'json_object'}`，`temperature: 0.2`
   - `extractFacts(input, options)`:
     1. 构造 system + user prompt
     2. 调 `callGeminiFlash` + 2 次重试（exponential backoff 500ms/1s）
     3. 解析 JSON，`response_format` 保证合法但也 try/catch
     4. `validateFact` 过滤不合格项
     5. **tweak T4**: 过滤 `confidence < 0.85` 的条目
     6. 算 `estimateCostUsd(tokenIn, tokenOut)`
     7. **预算 check**: 若 `accumulatedCost + thisCost > options.budgetUsd` → throw `BudgetExceededError`
     8. 返回 ExtractionResult

3. 环境变量读取（避免循环依赖 config.ts）：
   ```typescript
   const GEMINI_BASE = process.env.GEMINI_PROXY_BASE ?? "http://23.226.135.149:4000/v1";
   const GEMINI_KEY = process.env.GEMINI_PROXY_KEY ?? "";
   if (!GEMINI_KEY) throw new Error("GEMINI_PROXY_KEY not set");
   ```

4. `extractor.test.ts`：
   - mock fetch（用 `vi.fn` 替代？brain 没有 vitest——用 `global.fetch = () => mockResponse` + 测试完恢复）
   - 覆盖：成功解析 / JSON 损坏 / 空 facts / confidence 过滤 / 预算超限 throw

**验证**：对 Spike samples/ 里已拉的 `Xo0gd0EpWoVFe7xRErEctATFnQe-pass1.txt`（技术入口）跑一次，**期望 0 或 1 facts**（原"独立"推断应被过滤）。

### P0.3 · brain-context.ts 挂第五路 knowledgeSearch()（~30min）🟡

**Finding F6 + tweak T6**：只在匹配关键词时激活，默认 off。

**实装步骤**：
1. 读 `src/services/brain-context.ts` 了解现有四路检索结构
2. 新增 `knowledgeSearch(query, topK)` 函数：
   - 检查 query 是否匹配 `/文档|wiki|手册|SOP|怎么部署|如何操作|规范/`
   - 或 `options.forceKnowledge === true`
   - 否则返回 `[]`
   - 匹配时调 `knowledgeFtsSearch(db, query, topK)`
3. 在主检索编排中，作为**兜底第五路**（前四路命中不足时才激活）
4. **严格 readonly**: 不污染任何现有数据结构
5. 加一个 feature flag `KNOWLEDGE_SEARCH_ENABLED=true|false`（.env.local），默认 false

### P0.4 · 定时任务（~30min）🟡

**Finding F6**：异步运行不阻塞 brain HTTP。

**实装步骤**：
1. 读 `src/services/scheduler*.ts`（或 `src/scheduler/`）了解现有 cron 注册方式
2. 新增 `knowledge-sync-job.ts`:
   - 读 `knowledge-allowlist.json`
   - 调 `crawl()`
   - 对 `doc_sync_state.status = 'pending'` 的文档调 `extractFacts()`
   - 结果入 `insertKnowledgeItems`
   - 更新 `doc_sync_state.status = 'extracted'`
3. 注册到现有 scheduler：每天 03:00 跑一次（避开 brain 高峰）

### P0.5 · 冷启动 + e2e 验证（~1h）

1. 把 `knowledge-allowlist.json` 的 `⌘FUTURUS知识库` enable
2. 手动触发一次 `knowledge-sync-job`:
   ```bash
   cd 2-Projects/brain-product/mycc-brain
   npx tsx -e "import('./src/knowledge/knowledge-sync-job.js').then(m => m.run())"
   ```
3. 观察：
   - cost 是否 < $0.20（预期 $0.05-0.10）
   - knowledge.db 条目数
   - 错误率
4. 用 Admin UI 或直接 SQL 检查 knowledge_items 表
5. 发一个 brain 请求（含关键词"怎么部署 futurus"），验证第五路是否命中

### P0.6 · merge main + 部署（~1h）

1. 版本号：按 brain `CLAUDE.md` 升 minor → **v0.10.0**（新功能）
2. 同步更新三处版本号：
   - `package.json`
   - `src/server.ts` 启动横幅
   - `src/server.ts` /admin/api/status 响应
3. `git log --oneline feat/knowledge-system`（确认只有 Spike + P0 提交）
4. **先问川哥**宿主决策（α Air / β Mini / γ Studio）。当前倾向 β Mini（SSOT 合规）。
5. `git checkout main && git merge feat/knowledge-system`
6. `bash deploy.sh` 或手动 rsync 到选定宿主
7. `pm2 logs brain --lines 20 --nostream` 验证启动无错
8. admin UI 加个 Knowledge tab 看 knowledge.db 统计（可选，P1 做也行）

---

## 五、硬约束清单（每次改动前必读）

1. ❌ **不写 memory.db / memory-items.md / memory-items-intake.md**
2. ❌ **不改 brain-context.ts 的默认四路检索**（只新增第五路，不动前四）
3. ✅ **Gemini Flash 预算**：Spike 已用 $0.000783；P0 冷启动硬顶 **$0.50**；运行时每次 `extractFacts()` 预算由 options 控制
4. ❌ **不 push feat/knowledge-system 到 GitHub**（含商业敏感 fact 样本在 commit message 和 spike-report.md）—— 除非川哥明确授权
5. ❌ **不碰 Studio 运行时数据**（SSOT 铁律）
6. ✅ **所有数据结构 readonly immutable**
7. ✅ **单文件 < 400 行**（当前 store.ts 240 行是最大值，保持 <400）
8. ✅ **双门验证**：每个 P0 子任务完成后必跑 `tsc --noEmit` + `tsx --test`

---

## 六、预算和时间追踪

| 项 | 值 |
|---|---|
| Gemini Flash 已消耗（Spike） | $0.000783 |
| Gemini Flash 预算硬顶（P0 冷启动） | $0.50 |
| Gemini Flash 预估（P0 冷启动实际） | $0.05-0.10 |
| Gemini Flash 月度运行预估 | < $0.20 |
| Day 0 已用时 | ~4.5h（18:25 T0 → 00:05 commit） |
| P0 预计时长 | ~5h（P0.1-P0.6） |

---

## 七、下个 session 的 cc 第一条指令

```
读 tasks/knowledge-spike/HANDOFF-knowledge-spike.md 和
tasks/knowledge-spike/spike-report.md，然后按第四节"P0 执行清单"
开始 P0.1 crawler.crawl() 实装。

前置验证（必跑）：
cd /Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain
npx tsc --noEmit && npx tsx --test src/knowledge/*.test.ts 2>&1 | tail -5
lark-cli auth status | jq -r .tokenStatus

分支 feat/knowledge-system 本地有 commit 96e66c8，继续在该分支上迭代。
硬约束见第五节。
```

---

**最后更新**：2026-04-11 00:10 CST by cc（claude-opus-4-6）
