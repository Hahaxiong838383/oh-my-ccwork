# HANDOFF — P0.3 brain-context + P0.4 scheduler + P0.5/P0.6 验证部署

> 阶段：**P0.1 + P0.2 完成** → **P0.3 + P0.4 并行实装 → P0.5 e2e → P0.6 部署**
> 前置：`feat/knowledge-system` 分支，P0.1+P0.2 commit 已落（48/48 tests pass, tsc ✓）
> 执行模式：**Agent team 并行**（Agent A 做 P0.3，Agent B 做 P0.4），主 cc 汇总 + 串行跑 P0.5/P0.6
> 预计用时：~3h

---

## 一、20 秒速览

```
P0.3 (Agent A)  ┐
                ├─→ 主 cc 汇总 → P0.5 e2e → 川哥宿主决策 → P0.6 部署
P0.4 (Agent B)  ┘
   └────── 并行 (~1h) ──────┘    └── 串行 (~2h) ──┘
```

| 子任务 | 谁做 | 产出 | 依赖 |
|---|---|---|---|
| **P0.3** | Agent A | `src/knowledge/search.ts` + 改 `src/services/brain-context.ts` 加第五路 | store.ts (已有) |
| **P0.4** | Agent B | `src/knowledge/knowledge-sync-job.ts` + 注册 scheduler | crawler + extractor + store (已有) |
| **P0.5** | 主 cc | e2e：跑一次 sync job + 发 brain 请求验证第五路 | P0.3 + P0.4 |
| **P0.6** | 主 cc | 版本升 v0.10.0 + merge main + deploy | P0.5 + 川哥宿主决策 |

**并行零冲突保证**：
- Agent A 只动 `src/services/brain-context.ts` + 新建 `src/knowledge/search.ts` + 新建 `src/knowledge/search.test.ts`
- Agent B 只动 `src/scheduler/*`（或类似）+ 新建 `src/knowledge/knowledge-sync-job.ts` + 新建 `src/knowledge/knowledge-sync-job.test.ts`
- 都读 `src/knowledge/store.ts` / `crawler.ts` / `extractor.ts` / `allowlist.ts` 但**不修改**

---

## 二、前置验证（主 cc 启动后第一件事）

```bash
cd /Users/rayman.chen/mycc
git branch --show-current                                      # feat/knowledge-system
git log --oneline -3                                           # 应见 P0.1+P0.2 commit
cd 2-Projects/brain-product/mycc-brain
npx tsc --noEmit                                               # 应通过
npx tsx --test src/knowledge/*.test.ts 2>&1 | tail -5          # 应 48/48 pass
lark-cli auth status | jq -r .tokenStatus                      # valid
ls data/knowledge-allowlist.json 2>/dev/null && echo EXISTS    # 应已存在
```

**如果 knowledge-allowlist.json 不存在**：
```bash
cat > data/knowledge-allowlist.json <<'EOF'
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
EOF
```

---

## 三、Agent A — P0.3 brain-context 第五路 knowledgeSearch

### 3.1 目标
给 brain-context.ts 加第五路检索：**默认 off**，仅在 query 匹配关键词（文档/wiki/手册/SOP/怎么部署...）或 `forceEnable` 时激活，调 `knowledgeFtsSearch` 返回兜底结果。**不改原四路**。

### 3.2 Finding F6 + tweak T6 触发
不能阻塞 brain HTTP 路径；默认关闭避免污染现有检索。

### 3.3 Agent A 的完整任务 Prompt

```
你是 Agent A，负责实装 mycc-brain 外挂知识系统的 P0.3 子任务：
brain-context.ts 第五路 knowledgeSearch。

【上下文】
- 当前在 /Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/
- 分支 feat/knowledge-system，P0.1+P0.2 已完成
- src/knowledge/ 已有 types/store/allowlist/crawler/extractor 全部实装
- src/knowledge/store.ts 已有 knowledgeFtsSearch / openKnowledgeDB / closeKnowledgeDB
- 不要动 crawler.ts / extractor.ts / knowledge-sync-job.ts（Agent B 正在动后者）

【硬约束】
- 不改原四路检索逻辑
- 默认 off：KNOWLEDGE_SEARCH_ENABLED!='true' → 返回 []
- 所有数据结构 readonly immutable
- 单文件 < 400 行
- import 带 .js 后缀
- readonly + immutable，不 mutate 入参

【Step 1: 读现有代码（只读）】
1. 读 src/services/brain-context.ts，找到：
   - 主检索编排函数（可能叫 gatherBrainContext / buildContext / similar）
   - 现有四路的调用点和返回聚合方式
   - 当前的 imports 和类型定义
2. 读 src/knowledge/store.ts 确认 knowledgeFtsSearch 签名
3. 读 src/knowledge/types.ts 确认 KnowledgeSearchHit 类型

【Step 2: 新建 src/knowledge/search.ts】
内容要求：
- 导出 knowledgeSearch(query, topK?, options?) 函数
- 模块级 singleton cache KnowledgeDatabase（懒加载，进程退出释放）
- 关键词触发白名单（正则数组）：
  /文档|wiki|手册|sop|规范/i,
  /怎么部署|怎么使用|怎么配置|如何操作|如何配置/,
  /流程|步骤|操作方法|指南/,
- shouldTriggerKnowledgeSearch(query): 检查 KNOWLEDGE_SEARCH_ENABLED !== 'true' → false；否则匹配任一正则 → true
- knowledgeSearch 签名：
  async function knowledgeSearch(
    query: string,
    topK?: number,
    options?: { readonly forceEnable?: boolean; readonly dbPath?: string },
  ): Promise<readonly KnowledgeSearchHit[]>
- 逻辑：
  1. !options.forceEnable && !shouldTriggerKnowledgeSearch(query) → return []
  2. 懒加载 DB: path = options.dbPath ?? process.env.KNOWLEDGE_DB_PATH ?? path.join(process.env.DATA_DIR ?? '.', 'knowledge.db')
  3. 若 db 打开失败，return []（不抛错，日志 console.error）
  4. const hits = knowledgeFtsSearch(db, query, topK ?? 5)
  5. return hits
- 导出辅助：resetKnowledgeSearchCache() 给测试用（关闭 cached db）

【Step 3: 改 src/services/brain-context.ts】
1. 在文件顶部 import: import { knowledgeSearch } from "../knowledge/search.js";
2. 找到主检索聚合函数，在**所有现有四路检索完成后**追加：
   - 调 knowledgeSearch(query, 5)（默认路径，default options）
   - 若返回非空，把结果**以新的独立字段**合并到返回结构（不要污染现有四路的统计字段）
   - 字段名建议 'knowledge' 或 'externalKnowledge'
3. 如果主检索函数有 interface/type 定义（比如 BrainContextResult），给它扩一个 readonly knowledge?: readonly KnowledgeSearchHit[]
4. 不改任何现有四路的数据流或阈值
5. 只动必要的行数，尽量减少 diff

【Step 4: 新建 src/knowledge/search.test.ts】
用 node:test + tsx，测试：
1. shouldTriggerKnowledgeSearch 默认环境变量 → false
2. shouldTriggerKnowledgeSearch env=true + 关键词 → true
3. shouldTriggerKnowledgeSearch env=true + 无关键词 → false
4. knowledgeSearch forceEnable → 即使无关键词也执行
5. knowledgeSearch 无关键词 + 默认 → 返回 []
6. knowledgeSearch 正常路径 → 用 :memory: 初始化 + 插条 → 查询命中

测试前后记得：
- 设置/还原 process.env.KNOWLEDGE_SEARCH_ENABLED
- 每个 test 末尾 resetKnowledgeSearchCache()

【Step 5: 双门验证】
npx tsc --noEmit
npx tsx --test src/knowledge/*.test.ts 2>&1 | tail -10
应看到原 48/48 + P0.3 新增 6 tests = 54/54

【Step 6: 向主 cc 报告】
返回：
1. search.ts 最终行数
2. brain-context.ts 的 diff（git diff --stat）
3. test 全绿截图
4. 遇到的坑（如果有）

【权限处理】
如果遇到 Write 被权限卡住：停下来，把完整文件内容（search.ts + search.test.ts）+ brain-context.ts 的精确 diff 作为文本返回给主 cc，由主 cc 代写。
```

### 3.4 P0.3 Acceptance
- [ ] `src/knowledge/search.ts` 新建（< 150 行）
- [ ] `src/knowledge/search.test.ts` 新建，6+ tests
- [ ] `src/services/brain-context.ts` diff 最小化（仅加 import + 一路调用 + 一个 type 字段）
- [ ] `KNOWLEDGE_SEARCH_ENABLED` 默认 off
- [ ] tsc ✓ + tsx test 全绿（预期 54/54）

---

## 四、Agent B — P0.4 scheduler knowledge-sync-job

### 4.1 目标
新建定时任务：编排 `crawl` → 读 `pending` 队列 → `extractFacts` → 写 `knowledge_items` + 更新 `doc_sync_state`。注册到现有 scheduler，每天 03:00 跑一次。

### 4.2 Finding F6 触发
必须异步运行，不在 brain HTTP 路径上。

### 4.3 Agent B 的完整任务 Prompt

```
你是 Agent B，负责实装 mycc-brain 外挂知识系统的 P0.4 子任务：
scheduler knowledge-sync-job 定时任务。

【上下文】
- 当前在 /Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain/
- 分支 feat/knowledge-system，P0.1+P0.2 已完成
- src/knowledge/ 已有 crawler.crawl / extractor.extractFacts / store.insertKnowledgeItems 等全部可用
- 不要动 brain-context.ts / search.ts（Agent A 正在动前者，后者不存在）
- 不要动 crawler.ts / extractor.ts / store.ts（已稳定，只读调用）

【硬约束】
- 预算硬顶 $0.50 每次运行
- 所有数据结构 readonly immutable
- 单文件 < 400 行
- import 带 .js 后缀
- 失败隔离：单篇文档 extract 失败不中断整个 job
- BudgetExceededError 直接中断本次 job 并记录

【Step 1: 读现有代码（只读）】
1. 找 scheduler 的入口位置：
   - ls src/scheduler/ 或 grep -r "cron" src/
   - 看现有 cron 任务怎么注册（文件名参考：scheduler.ts / cron-jobs.ts / tasks.ts）
   - 看注册模式：config 数组？装饰器？函数调用？
2. 读 src/knowledge/crawler.ts 确认 crawl / fetchDocContent 签名 + CrawlerOptions
3. 读 src/knowledge/extractor.ts 确认 extractFacts / GeminiClientConfig / BudgetExceededError
4. 读 src/knowledge/store.ts 确认 listDocSyncStatesByStatus / insertKnowledgeItems / upsertDocSyncState
5. 读 src/knowledge/allowlist.ts 确认 loadAllowlist 签名

【Step 2: 新建 src/knowledge/knowledge-sync-job.ts】
导出：
1. interface SyncJobOptions {
     readonly budgetUsd: number;
     readonly maxDocs: number;
     readonly allowlistPath: string;
     readonly knowledgeDbPath: string;
     readonly geminiApiKey: string;
     readonly geminiBaseUrl?: string;   // default http://23.226.135.149:4000/v1
     readonly geminiModel?: string;     // default gemini-2.5-flash
     readonly pendingBatchSize?: number; // default 50
   }
2. interface SyncJobResult {
     readonly crawlerResult: CrawlerResult;
     readonly docsProcessed: number;
     readonly docsExtracted: number;
     readonly docsFailed: number;
     readonly factsInserted: number;
     readonly totalCostUsd: number;
     readonly errors: readonly string[];
     readonly stoppedByBudget: boolean;
   }
3. async function runKnowledgeSyncJob(options: SyncJobOptions): Promise<SyncJobResult>

runKnowledgeSyncJob 逻辑：
  1. loadAllowlist(options.allowlistPath)
  2. const db = await openKnowledgeDB(options.knowledgeDbPath); 若 null 抛
  3. try { ... } finally { closeKnowledgeDB(db) }
  4. Phase A: crawl({db, allowlist, dryRun:false, maxDocs:options.maxDocs, apiDelayMs:300}) → crawlerResult
  5. Phase B: 取 pending 队列 listDocSyncStatesByStatus(db, "pending", options.pendingBatchSize ?? 50)
  6. 构造 GeminiClientConfig：
     { baseUrl: options.geminiBaseUrl ?? 'http://23.226.135.149:4000/v1',
       apiKey: options.geminiApiKey,
       model: options.geminiModel ?? 'gemini-2.5-flash',
       maxTokens: 4096,
       temperature: 0.2 }
  7. 遍历 pending，对每个 state：
     a. 预算安全边界检查：accumulatedCost > budget*0.95 → stoppedByBudget=true; break
     b. try:
        - const content = await fetchDocContent(state.docToken) （从 crawler.ts import）
        - const result = await extractFacts({docToken, docTitle, contentHash, content}, {client, budgetUsd:options.budgetUsd}, accumulatedCost)
        - accumulatedCost += result.costUsd
        - 若 facts 非空: insertKnowledgeItems(db, facts 转 KnowledgeItemInput[]) （sourceUrl = `https://feishu.cn/docx/${docToken}`, extractedBy: 'gemini-flash'）
        - upsertDocSyncState(db, {...state, status:'extracted', lastExtractedAt:Date.now(), errorMessage:''})
        - factsInserted += facts.length; docsExtracted++
     c. catch (err):
        - docsFailed++
        - errors.push(`${docToken}: ${msg}`)
        - upsertDocSyncState(db, {...state, status:'failed', errorMessage: msg.slice(0,500)})
        - if (err instanceof BudgetExceededError) { stoppedByBudget=true; break; }
  8. 返回 SyncJobResult

【Step 3: 注册到 scheduler】
根据 Step 1 找到的现有注册模式，加一条：
- name: 'knowledge-sync'
- cron: '0 3 * * *'
- handler: async () => {
    const result = await runKnowledgeSyncJob({
      budgetUsd: 0.50,
      maxDocs: 200,
      allowlistPath: path.join(BRAIN_ROOT, 'data/knowledge-allowlist.json'),
      knowledgeDbPath: path.join(process.env.DATA_DIR ?? BRAIN_ROOT + '/data', 'knowledge.db'),
      geminiApiKey: process.env.GEMINI_PROXY_KEY ?? '',
    });
    console.log('[knowledge-sync]', JSON.stringify(result));
  }

如果 scheduler 需要在某个 init 函数里手动注册，找到那个函数加入。
不要改 scheduler 核心，只加一条配置。

【Step 4: 新建 src/knowledge/knowledge-sync-job.test.ts】
用 node:test，测试：
1. runKnowledgeSyncJob mock crawl + mock extractFacts → 正常路径返回 SyncJobResult
2. crawl 返回空 pending → docsProcessed=0, factsInserted=0
3. extract 个别失败 → 其他继续，failed 计入
4. BudgetExceededError → stoppedByBudget=true, break 循环
5. 无 facts 的文档 → 状态变 extracted，factsInserted 不增

关键难点：runKnowledgeSyncJob 内部直接 import fetchDocContent / extractFacts / crawl 了。要支持 mock，把它们做成可注入参数：

接口扩展：
export interface SyncJobDeps {
  readonly crawl: typeof crawl;
  readonly fetchDocContent: typeof fetchDocContent;
  readonly extractFacts: typeof extractFacts;
}
export const defaultSyncJobDeps: SyncJobDeps = { crawl, fetchDocContent, extractFacts };

runKnowledgeSyncJob(options, deps = defaultSyncJobDeps)

测试时注入 mock deps，不碰真实 API。

【Step 5: 双门验证】
npx tsc --noEmit
npx tsx --test src/knowledge/*.test.ts 2>&1 | tail -10
应看到原 48/48 + P0.4 新增 5 tests = 53/53
（注意：Agent A 也会新增 6，但 A/B 并行，最后 merge 后一起跑是 54+5=59）

【Step 6: 向主 cc 报告】
返回：
1. knowledge-sync-job.ts 最终行数
2. scheduler 注册 diff
3. test 全绿
4. 遇到的坑

【权限处理】
如果遇到 Write 被权限卡住：停下来，把完整文件内容 + 现有 scheduler 的 diff 返回，由主 cc 代写。

【特别注意 scheduler 位置】
brain 的 scheduler 具体位置可能是：
- src/scheduler.ts
- src/scheduler/index.ts
- src/services/scheduler.ts
- 嵌入在 server.ts 里
第一步必须先找到，grep -rn "cron\|schedule" src/ 就能定位。
```

### 4.4 P0.4 Acceptance
- [ ] `src/knowledge/knowledge-sync-job.ts` 新建（< 400 行）
- [ ] `src/knowledge/knowledge-sync-job.test.ts` 新建，5+ tests
- [ ] scheduler 注册一条 `knowledge-sync` cron
- [ ] 支持 SyncJobDeps 依赖注入（方便测试）
- [ ] 预算 check 有效（BudgetExceededError 捕获 + stoppedByBudget 标记）
- [ ] tsc ✓ + tsx test 全绿

---

## 五、主 cc — P0.5 e2e 验证（~1h）

前提：Agent A + Agent B 都已完成 + test 全绿。

### 5.1 全量双门验证
```bash
cd /Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain
npx tsc --noEmit
npx tsx --test src/knowledge/*.test.ts 2>&1 | tail -10
# 预期 ~59/59 pass（48 原 + 6 search + 5 sync-job）
```

### 5.2 手动跑一次 sync job（冷启动）
```bash
# 准备环境
export KNOWLEDGE_SEARCH_ENABLED=true
export GEMINI_PROXY_KEY=$(grep GEMINI_PROXY_KEY .env.local | cut -d= -f2- | tr -d '"')
export DATA_DIR=$(pwd)/data

# 跑一次
npx tsx -e '
import { runKnowledgeSyncJob } from "./src/knowledge/knowledge-sync-job.js";
const result = await runKnowledgeSyncJob({
  budgetUsd: 0.20,
  maxDocs: 30,
  allowlistPath: "./data/knowledge-allowlist.json",
  knowledgeDbPath: "./data/knowledge.db",
  geminiApiKey: process.env.GEMINI_PROXY_KEY,
});
console.log(JSON.stringify(result, null, 2));
'
```

**预期**：
- `crawlerResult.totalDocs` 约 50-200（⌘FUTURUS知识库叶子数）
- `factsInserted` 约 100-500
- `totalCostUsd` < $0.20
- `errors.length` 0 或极少

### 5.3 检查 knowledge.db
```bash
sqlite3 data/knowledge.db <<'SQL'
SELECT COUNT(*) AS items FROM knowledge_items;
SELECT namespace, COUNT(*) FROM knowledge_items GROUP BY namespace ORDER BY 2 DESC LIMIT 10;
SELECT COUNT(*), status FROM doc_sync_state GROUP BY status;
SELECT doc_title, content FROM knowledge_items LIMIT 5;
SQL
```

### 5.4 验证第五路激活
```bash
# 启动 brain（测试模式）
KNOWLEDGE_SEARCH_ENABLED=true BRAIN_PORT=18089 npx tsx src/server.ts &
BRAIN_PID=$!
sleep 2

# 发一个触发关键词的请求
curl -s http://localhost:18089/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(grep BRAIN_API_KEY .env.local | cut -d= -f2-)" \
  -d '{"messages":[{"role":"user","content":"futurus 公司战略是什么？"}],"model":"cc-gemini-3.1-flash"}' \
  | jq .

kill $BRAIN_PID
```

**预期**：响应应该包含公司战略的原子事实（从 knowledge.db 召回）。

### 5.5 e2e 成功判据
- [ ] sync job 冷启动 < $0.20, facts ≥ 50
- [ ] doc_sync_state 无 failed 或 failed < 5%
- [ ] 关键词查询命中 knowledge.db 条目
- [ ] brain 响应时间增加 < 500ms（第五路 fts 查询应很快）

### 5.6 commit 中间点
```bash
cd /Users/rayman.chen/mycc
git add 2-Projects/brain-product/mycc-brain/src/knowledge/search.ts \
        2-Projects/brain-product/mycc-brain/src/knowledge/search.test.ts \
        2-Projects/brain-product/mycc-brain/src/knowledge/knowledge-sync-job.ts \
        2-Projects/brain-product/mycc-brain/src/knowledge/knowledge-sync-job.test.ts \
        2-Projects/brain-product/mycc-brain/src/services/brain-context.ts \
        # 以及 scheduler 修改的文件（具体看 Agent B 改了什么）
git commit -m "feat(brain): P0.3 brain-context 第五路 + P0.4 scheduler sync job (..详情)"
```

---

## 六、主 cc — P0.6 部署（~1h，需川哥决策）

### 6.1 宿主决策（必须先问川哥）

| 方案 | 位置 | 优点 | 缺点 | 推荐度 |
|---|---|---|---|---|
| α | Air 开发机 | 最简单，本地跑 | 不符合 SSOT（运行时应在服务端）；Air 关机就挂 | ⚠️ 低 |
| **β** | **Mini → rsync 到 Studio** | **符合 SSOT 铁律 2**；Mini 已有 lark-cli；事件上报架构 | 需要同步凭据 + cron 双端 | ✅ **推荐** |
| γ | Studio all-in-one | all-in-one 简单 | Studio 目前没装 lark-cli + token；违反"Studio 纯算力"定位 | ⚠️ 中 |

**向川哥发问**：
```
P0.6 部署需要你拍板宿主：
- α Air: 最简单本地跑，关机就挂
- β Mini → Studio rsync: 符合 SSOT，Mini 已有 lark-cli（推荐）
- γ Studio all-in-one: 要补装 lark-cli + token 到 Studio

我建议 β。你的决策？
```

等川哥回复后再继续。

### 6.2 版本号升级（feat → minor + 1）

按 `2-Projects/brain-product/mycc-brain/CLAUDE.md` 强制流程，三处必须同步：

```bash
# 1. package.json
sed -i '' 's/"version": "0.9.3"/"version": "0.10.0"/' package.json

# 2. src/server.ts 启动横幅
# 找到 `mycc-brain v0.9.3` 或类似字样，改成 v0.10.0

# 3. src/server.ts /admin/api/status
# 找到 version: '0.9.3' 或 const VERSION = '0.9.3'，改成 0.10.0
```

**验证一致性**：
```bash
grep '"version"' package.json
grep -n "mycc-brain v\|version" src/server.ts | head -10
# 应全部 0.10.0
```

### 6.3 merge main + push?

**不要 push**（分支名 feat/knowledge-system 承诺"不 push 直到明确授权"）。只做 local merge：

```bash
cd /Users/rayman.chen/mycc
git checkout main
git pull --ff-only  # 先同步远端（如果有）
git merge --no-ff feat/knowledge-system -m "Merge feat/knowledge-system: 外挂知识系统 v0.10.0"
# 检查 merge 后的 diff
git log --oneline -10
```

**如果川哥明确授权 push**：`git push origin main`。否则停住问。

### 6.4 部署（按 β 方案）

```bash
# 先确认 brain 项目 deploy.sh 有没有针对 knowledge 的改动
cat 2-Projects/brain-product/mycc-brain/deploy.sh | grep -i knowledge || echo "no knowledge-specific handling"

# 关键：knowledge-allowlist.json 和 knowledge.db 需要特殊处理
# - allowlist.json 走 rsync 部署（带过去）
# - knowledge.db 不 rsync（每台机器独立）

# 实际部署（β 方案）：
# Step 1: rsync Mini
cd 2-Projects/brain-product/mycc-brain
bash deploy.sh  # 或按现有 mini 部署流程

# Step 2: ssh mini 手动跑一次 sync job 冷启动（目标机）
ssh mini "cd mycc-brain && KNOWLEDGE_SEARCH_ENABLED=true node dist/knowledge/trigger-sync-once.js"
# 或类似的 one-shot 命令

# Step 3: pm2 reload brain（让新版本生效）
ssh mini "pm2 reload brain && pm2 logs brain --lines 10 --nostream"

# Step 4: 冒烟测试
curl -s http://$(ssh mini 'hostname -I | awk "{print $1}"'):18080/admin/api/status | jq .version
# 应返回 "0.10.0"
```

### 6.5 部署后验证
- [ ] `pm2 logs brain` 无错
- [ ] `/admin/api/status` 返回 `version: "0.10.0"`
- [ ] 发一个触发关键词的 brain 请求，响应包含 knowledge 条目
- [ ] `knowledge.db` 在 Mini 上创建且 items > 0
- [ ] 下个 03:00 自动 sync job 要监控一次（第二天）

### 6.6 收工
- [ ] 更新 HANDOFF-knowledge-spike.md 标记 P0 全部完成
- [ ] 追加 RECENT_EVENTS.md（P0.3/P0.4/P0.5/P0.6 完成事件）
- [ ] 给川哥部署报告 + 数字
- [ ] 给川哥可粘贴提示词（如果后续还有 P1 工作）

---

## 七、硬约束回顾

1. ❌ **不改原四路检索**（brain-context.ts 只加第五路）
2. ❌ **不写 memory.db**
3. ✅ **KNOWLEDGE_SEARCH_ENABLED 默认 off**
4. ✅ **预算硬顶 $0.50/次**
5. ❌ **不 push 到 GitHub**（除非川哥明确授权）
6. ✅ **readonly immutable**
7. ✅ **单文件 < 400 行**
8. ✅ **双门验证**每步必跑
9. ✅ **版本号三处同步**（P0.6 merge 前）

---

## 八、Agent 编排的避坑清单

| 坑 | 避坑 |
|---|---|
| A/B 同时改 store.ts | 零风险：两 agent 都只读 store.ts |
| A/B 同时改 crawler/extractor | 零风险：都只读 |
| scheduler 位置找不到 | Agent B Step 1 必须先定位，找不到就 ESCALATE |
| subagent 写入权限卡 | 每个 agent 的 Step 6 都有 fallback：返回代码/diff 由主 cc 代写 |
| 测试并行跑 race | 每个 test 用 :memory: DB，无共享状态 |
| brain-context 五路数据污染 | Agent A 用新字段（`knowledge`）隔离，不改现有字段 |
| singleton DB cache 在 test 中泄漏 | 提供 `resetKnowledgeSearchCache()` 导出，每 test 清一次 |

---

**最后更新**：2026-04-11 00:45 CST by cc（claude-opus-4-6）
**状态**：待 P0.3-P0.6 实装（Agent team 并行模式）
