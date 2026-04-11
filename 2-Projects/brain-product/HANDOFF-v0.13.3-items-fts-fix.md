# HANDOFF — brain v0.13.3 items_fts schema 漂移修复

**日期**：2026-04-11 22:01 CST
**来源 session**：cc 诊断 SQLITE_MISMATCH bug（v0.13.1→v0.13.2 批次）
**接手 session**：[新 session]
**状态**：✅ 已完成（2026-04-11 22:27 CST，commit a355710，部署 v0.13.3，三门通过）

---

## 0. TL;DR

v0.13.1 HANDOFF 描述的 **P0 SQLITE_MISMATCH bug 诊断方向错了**。上个 session 把修复做在 items_vec（向量表），但实际根因在 **items_fts（FTS5 虚表）的 schema 漂移 + items_ad TRIGGER**。

**v0.13.2 已部署但没修到真正的 bug**：
- ✅ chat HTTP 200（实测 cc-gemini-2.5-flash curl 正常返回）
- ✅ 启动横幅 v0.13.2 正常，pm2 online
- ⚪ items_vec 修复是**死代码路径**（Studio 上 sqlite-vec 未加载）
- ❌ items_fts schema 漂移仍在，error log 仍污染

**你的任务**：写 v0.13.3 修复 items_fts schema 漂移（和 ensureVecSchemaVersion 同类 pattern），消除日志污染。

**预估时间**：2 小时（含 codex 写 patch + tsc + deploy + 验证）

---

## 1. 当前状态（截止交接时）

### brain 版本
- **v0.13.2** 已部署 Studio，pm2 online，pid 36057
- git: 最新 commit `0d2f64e fix(brain): v0.13.2 SQLITE_MISMATCH 修复（items_vec schema 自动迁移 + 嵌入维度对齐 1024）`
- 未 push 的 commit 共 **3 个**：`0d2f64e` + `5bcfbbd` + `8c4e0c6`（本地 main 领先 origin/main 3 个 commit）

### 访问入口
- Admin UI: `http://cli4.hahaxiong.cc:19080/admin` ⚠️ **http 不是 https**
- API: `http://10.9.1.155:19080/v1/chat/completions`
- Auth: `Bearer sk-brain-dev`
- SSH 跳板: `studio-pub`（经 mini 跳板 ProxyJump）

### 实测验证（上 session 已做）
```bash
ssh studio-pub 'curl -s -o /tmp/resp.txt -w "HTTP=%{http_code}" http://localhost:19080/v1/chat/completions \
  -H "Authorization: Bearer sk-brain-dev" -H "Content-Type: application/json" \
  -d "{\"model\":\"cc-gemini-2.5-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"说hi\"}],\"max_tokens\":30}"; head -c 500 /tmp/resp.txt'
```
**结果**：`HTTP=200`，streaming 正常返回 `{"content":"hi"}` —— 说明 **chat 没 500**，HANDOFF 原描述误导。

---

## 2. 真正的根因（完整证据链）

### 2.1 错误 stack trace（来自 `~/.pm2/logs/brain-error.log`）

```
[memory-db] sqlite-vec not available, vector search disabled
[memory-db] syncFromMd failed: SqliteError: datatype mismatch
    at Database.exec (.../better-sqlite3/lib/methods/wrappers.js:9:14)
    at memory-db.ts:157:10              ← v0.13.2 后行号，即 `db.exec("DELETE FROM items")`
    at sqliteTransaction (.../better-sqlite3/lib/methods/transaction.js:65:24)
    at syncFromMd (memory-db.ts:166:5)
    at brain-context.ts:335:7
    at async Promise.all (index 0)
    at loadBrainContext (brain-context.ts:358:3)
    at buildAdminBrainMessages (server.ts:204:23)
  code: 'SQLITE_MISMATCH'
```

**两个关键信号**：
1. `[memory-db] sqlite-vec not available, vector search disabled` — Studio 上 **sqlite-vec 根本没加载**，`vectorSearch` 永远 return [] → items_vec 修复路径**完全没跑**
2. 错误 stack 明确指向 `db.exec("DELETE FROM items")` 触发的 **items_ad TRIGGER**（AFTER DELETE ON items）

### 2.2 关键代码（memory-db.ts）

**Schema 定义**（v0.13.2 后，对应行号）：

```typescript
// src/services/memory-db.ts L72-89（等效位置，v0.13.2 后略下移）
db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    content  TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    category, content, content='items', content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, category, content)
    VALUES (new.id, new.category, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, category, content)
    VALUES ('delete', old.id, old.category, old.content);
  END;
`);
```

**触发点**（syncFromMd 的 transaction）：

```typescript
// src/services/memory-db.ts 等效 L156-165
const tx = db.transaction(() => {
  db.exec("DELETE FROM items");                                        // ← 触发 items_ad TRIGGER 抛错
  db.exec("INSERT INTO items_fts(items_fts) VALUES ('delete-all')");
  const insert = db.prepare("INSERT INTO items (category, content) VALUES (?, ?)");
  for (const item of items) {
    insert.run(item.category, item.content);
  }
});
tx();
```

### 2.3 根因推断（高置信度，需要你先 ssh 验证）

**生产 memory.db 里的 `items_fts` 虚表是老 schema**（可能只有 1 列，或者 column order 不同，或者没有 `content='items' content_rowid='id'` 的 external content 配置）。`CREATE VIRTUAL TABLE IF NOT EXISTS` 跳过已存在的表 → 代码期望的 4 列 INSERT 和生产实际列定义不匹配 → `datatype mismatch`。

**和 items_vec 是同类问题**：schema 漂移 + `IF NOT EXISTS` 失效。

### 2.4 为什么 chat 不 500？

1. `syncFromMd` L152 有 `catch` 包住整个 transaction
2. `brain-context.ts` 的 `ftsTask` IIFE 也有外层 try/catch
3. 错误被吞掉 + `console.error` 打日志
4. 程序继续运行，chat 正常响应
5. **"影响 chat 500"是 HANDOFF 的误报**，实际只是日志污染

---

## 3. 第一步诊断（上手做的第一件事）

**目标**：拿生产 memory.db 里 items_fts 的实际 schema，确认漂移假设。

```bash
ssh studio-pub 'sqlite3 /Users/fu-121/mycc-data/0-System/memory.db ".schema items_fts" 2>&1'
ssh studio-pub 'sqlite3 /Users/fu-121/mycc-data/0-System/memory.db "SELECT sql FROM sqlite_master WHERE name LIKE \"items_%\";" 2>&1'
```

**对比代码期望**：
```sql
CREATE VIRTUAL TABLE items_fts USING fts5(category, content, content='items', content_rowid='id');
```

**预期**：两者不一致（如果一致，说明根因在别处，重新调查）。

**把诊断结果写到 HANDOFF 评论区或回复 cc**。

---

## 4. 修复方案

### 4.1 核心：新增 `ensureFtsSchemaVersion()` 函数

参考 v0.13.2 已有的 `ensureVecSchemaVersion()`（memory-db.ts L63-85，这次 session 已加的），写一个对等函数检测 items_fts。

**设计**：
```typescript
// src/services/memory-db.ts
const EXPECTED_FTS_SCHEMA_MARKER = "content='items'";  // external content 配置关键标识

/**
 * 检测 items_fts 历史 schema 是否与当前代码期望一致。
 * 不一致时 DROP items_fts（以及关联 triggers）让后续 CREATE IF NOT EXISTS 重建。
 *
 * 重建后 items 表里的数据会通过 items_ai TRIGGER 在下次 sync 时重新索引。
 * 或者立即调用 `INSERT INTO items_fts(items_fts) VALUES('rebuild');` 强制同步。
 */
function ensureFtsSchemaVersion(db: DB): void {
  try {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='items_fts'"
    ).get() as { sql?: string } | undefined;
    if (!row?.sql) return; // 表不存在，让 CREATE IF NOT EXISTS 正常建

    // 检测两个关键维度：
    // 1. 是否声明为 external content（content='items'）
    // 2. 列是否是 (category, content)
    const sql = row.sql;
    const isExternalContent = sql.includes("content='items'") || sql.includes('content="items"');
    const hasBothColumns = sql.includes("category") && sql.includes("content");

    if (!isExternalContent || !hasBothColumns) {
      console.warn(
        `[memory-db] items_fts schema outdated (${sql.slice(0, 150)}...), rebuilding`
      );
      // 先 DROP triggers（否则 DROP TABLE 可能失败或留下孤儿 triggers）
      db.exec("DROP TRIGGER IF EXISTS items_ai");
      db.exec("DROP TRIGGER IF EXISTS items_ad");
      db.exec("DROP TABLE IF EXISTS items_fts");
      // CREATE 由 initDB 后续 db.exec(SCHEMA_SQL) 负责
    }
  } catch (err) {
    console.error("[memory-db] ensureFtsSchemaVersion failed:", err);
  }
}
```

**调用位置**（initDB 里，在 CREATE TABLE/TRIGGER 之前）：

```typescript
// src/services/memory-db.ts initDB
export async function initDB(dataDir: string): Promise<boolean> {
  if (db) return true;
  if (!(await loadDriver())) return false;

  try {
    const dbPath = join(dataDir, "memory.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = DELETE");

    // ⭐ 新增：先检测 items_fts schema 漂移
    ensureFtsSchemaVersion(db);

    db.exec(`
      CREATE TABLE IF NOT EXISTS items (...);
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(...);
      CREATE TRIGGER IF NOT EXISTS items_ai ...
      CREATE TRIGGER IF NOT EXISTS items_ad ...
    `);

    // ⭐ 新增：如果 items 表有历史数据但 items_fts 刚重建，立即 rebuild 索引
    try {
      const count = db.prepare("SELECT COUNT(*) as n FROM items").get() as { n: number };
      if (count.n > 0) {
        // external content FTS5 的官方 rebuild 指令
        db.exec("INSERT INTO items_fts(items_fts) VALUES('rebuild')");
        console.log(`[memory-db] items_fts rebuilt with ${count.n} rows from items table`);
      }
    } catch (err) {
      console.warn("[memory-db] items_fts rebuild check failed:", err);
    }

    // 原有 sqlite-vec 部分（v0.13.2 已修）
    if (await loadVec()) {
      ensureVecSchemaVersion(db);
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS items_vec USING vec0(...);`);
    }

    return true;
  } catch (err) {
    console.error("[memory-db] initDB failed:", err);
    db = null;
    return false;
  }
}
```

### 4.2 数据损失评估

- `DROP TABLE items_fts` 会丢失 FTS 索引
- 但 `items_fts` 是 **external content** 表（`content='items'`），索引数据全部从 `items` 表派生
- `INSERT INTO items_fts(items_fts) VALUES('rebuild')` 会扫描 items 表全量重建索引
- **`items` 表本身不动，零数据丢失**

### 4.3 风险

1. **DROP TRIGGER + DROP TABLE 顺序**：必须先 DROP triggers 再 DROP table（否则 SQLite 会报孤儿 trigger 错）
2. **rebuild 指令的 FTS5 兼容性**：`INSERT INTO items_fts(items_fts) VALUES('rebuild')` 是 FTS5 标准语法，better-sqlite3 支持，无风险
3. **ensureFtsSchemaVersion 自己抛错**：try/catch 包住，失败只打 error log，不阻塞 initDB
4. **首次部署后的迁移**：只发生一次（第一次启动时检测到旧 schema → rebuild），后续启动 ensureFtsSchemaVersion 什么都不做

---

## 5. 实施步骤（8 步）

### Step 1：cd 到 brain 目录 + 确认当前状态

```bash
cd /Users/rayman.chen/mycc/2-Projects/brain-product/mycc-brain
git log --oneline -5                      # 确认 HEAD 是 0d2f64e (v0.13.2)
grep '"version"' package.json             # 应该是 "0.13.2"
```

### Step 2：ssh 拿生产 items_fts 实际 schema（关键诊断）

```bash
ssh studio-pub 'sqlite3 /Users/fu-121/mycc-data/0-System/memory.db "SELECT sql FROM sqlite_master WHERE name LIKE \"items%\";"'
```

**把输出贴给 codex**，让它基于**实际 schema**而不是猜测写 patch。

### Step 3：派 codex 写 patch

用 `Skill codex:rescue` 或 `Agent codex:codex-rescue`，prompt 模板：

```
# 任务：写 brain v0.13.2 → v0.13.3 items_fts schema 漂移修复 patch

## 背景
v0.13.2 的 SQLITE_MISMATCH 修复做错了方向（items_vec 路径 sqlite-vec 未加载，是死代码）。
真正的 bug 在 items_fts 虚表 schema 漂移，导致 items_ad TRIGGER 的
`INSERT INTO items_fts(items_fts, rowid, category, content) VALUES ('delete', ...)` 抛 datatype mismatch。

错误 stack：
```
[memory-db] syncFromMd failed: SqliteError: datatype mismatch
    at Database.exec (better-sqlite3/wrappers.js:9:14)
    at memory-db.ts:157:10  ← db.exec("DELETE FROM items") 触发 items_ad TRIGGER
    at syncFromMd (memory-db.ts:166:5)
```

## 生产 schema（已 ssh 确认，请填实际输出）
```sql
-- 这里粘贴 Step 2 ssh 拿到的实际 items_fts schema
CREATE VIRTUAL TABLE items_fts USING fts5(...);  ← 填实际
```

## 代码期望 schema（memory-db.ts 里）
```sql
CREATE VIRTUAL TABLE items_fts USING fts5(
  category, content, content='items', content_rowid='id'
);
```

## 需要做的改动

1. memory-db.ts 新增 `ensureFtsSchemaVersion()` 函数（参考已有的 ensureVecSchemaVersion 同 pattern）
   - 读 sqlite_master 里 items_fts 的 sql
   - 如果缺 content='items' 或列不全 → DROP TRIGGER items_ai / items_ad + DROP TABLE items_fts
2. initDB() 里在 db.exec(SCHEMA_SQL) **之前**调用 ensureFtsSchemaVersion
3. initDB() 里 db.exec(SCHEMA_SQL) **之后**加一段：如果 items 表有数据，调
   `db.exec("INSERT INTO items_fts(items_fts) VALUES('rebuild')")` 强制同步索引
4. package.json version 0.13.2 → 0.13.3
5. src/server.ts 4 处版本号同步 + 启动横幅改 "items_fts schema 自动迁移 + FTS rebuild"
6. CLAUDE.md 版本历史追加一行

## 输出要求
- unified diff 格式
- 能 git apply
- tsc --noEmit 0 error
- 不要写测试
- ≤ 1500 字说明

开始。
```

### Step 4：应用 patch

```bash
# codex 输出的 diff 保存到 /tmp/brain-v0.13.3.patch
git apply --check /tmp/brain-v0.13.3.patch  # dry run
git apply /tmp/brain-v0.13.3.patch
```

### Step 5：tsc guard

```bash
npx tsc --noEmit
# 必须 exit 0
```

### Step 6：git commit（精确 5 个文件，不吞 pre-existing）

```bash
git add CLAUDE.md package.json src/server.ts src/services/memory-db.ts
# （embedding.ts 这次不改，只改 memory-db）
git diff --cached --stat
git commit -m "fix(brain): v0.13.3 items_fts schema 漂移修复 + FTS rebuild

根因：生产 memory.db 里的 items_fts 虚表是旧 schema，与代码期望不一致。
CREATE VIRTUAL TABLE IF NOT EXISTS 跳过已存在表，items_ad TRIGGER 的
INSERT INTO items_fts(items_fts, rowid, category, content) VALUES ('delete', ...)
因列定义不匹配抛 SQLITE_MISMATCH datatype mismatch。

修复：
1. memory-db.ts 新增 ensureFtsSchemaVersion()，检测 sqlite_master 里 items_fts
   实际 sql，缺 content='items' 或列不全则 DROP（含 triggers）
2. initDB 在 db.exec(SCHEMA_SQL) 前调用 ensureFtsSchemaVersion
3. initDB 在 CREATE 之后，items 表有数据时执行 INSERT items_fts(items_fts) VALUES('rebuild')
4. 版本号 0.13.2 → 0.13.3

数据损失评估：零。items_fts 是 external content 表，索引从 items 派生，rebuild 重建。

v0.13.1 HANDOFF 的 P0 bug 归因误导（说影响 chat 500），实测 chat HTTP 200，
本 bug 仅污染日志。v0.13.2 修了 items_vec 方向是死代码路径。v0.13.3 修正方向。"
```

### Step 7：部署

```bash
bash deploy.sh
# 等输出 "✅ 部署完成!" + pm2 显示 0.13.3 online
```

### Step 8：验证（3 个门）

**门 1：启动横幅**
```bash
ssh studio-pub 'tail -50 ~/.pm2/logs/brain-out.log | grep -A 3 "v0.13.3"'
# 应该看到 "🧠 mycc-brain v0.13.3 (...)"
```

**门 2：自动迁移日志**
```bash
ssh studio-pub 'tail -100 ~/.pm2/logs/brain-out.log | grep -E "items_fts|rebuild"'
# 应该看到:
# [memory-db] items_fts schema outdated (...), rebuilding
# [memory-db] items_fts rebuilt with N rows from items table
```

**门 3：error log 干净**
```bash
# 触发一次 loadBrainContext
ssh studio-pub 'curl -s -o /dev/null -w "HTTP=%{http_code}\n" http://localhost:19080/v1/chat/completions \
  -H "Authorization: Bearer sk-brain-dev" -H "Content-Type: application/json" \
  -d "{\"model\":\"cc-gemini-2.5-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"test\"}],\"max_tokens\":10}"'
# 期望 HTTP=200

sleep 3
ssh studio-pub 'tail -20 ~/.pm2/logs/brain-error.log | grep "SQLITE_MISMATCH"'
# 期望空输出（没有新的 SQLITE_MISMATCH）
```

**三门都过 → 修复成功**。

---

## 6. 关键文件索引

| 文件 | 绝对路径 | 用途 |
|---|---|---|
| memory-db.ts | `src/services/memory-db.ts` | 本次主要改动 |
| embedding.ts | `src/services/embedding.ts` | 本次不改（v0.13.2 已修） |
| server.ts | `src/server.ts` | 版本号 4 处 + 启动横幅 |
| package.json | `package.json` | 版本号 0.13.2→0.13.3 |
| CLAUDE.md | `CLAUDE.md` | 版本历史追加 |
| deploy.sh | `deploy.sh` | Air → Studio 部署 |
| pm2 out log | `~/.pm2/logs/brain-out.log`（Studio） | 启动横幅 + 迁移日志 |
| pm2 err log | `~/.pm2/logs/brain-error.log`（Studio） | 错误验证 |
| 生产 memory.db | `/Users/fu-121/mycc-data/0-System/memory.db`（Studio） | schema 诊断 |

### v0.13.2 已有的 pattern 参考

`src/services/memory-db.ts` 的 `ensureVecSchemaVersion()` 函数（v0.13.2 新增）— **完全可以复用这个 pattern 写 FTS 版本**。

---

## 7. 后续清理（非本 session 必做）

本次完成后，建议额外做（可选，不阻塞）：

1. **合并 3 个未 push commit**：`git push origin main`（如果你有权限推）
2. **更新 HANDOFF-gemini-integration-v0.13.md**：把 P0 SQLITE_MISMATCH 标为 ✅ 已解决（v0.13.3）
3. **更新 CLAUDE.md**：任务交付署名 + 追加 task-log
4. **追加 RECENT_EVENTS.md**：本次修复的事件记录

---

## 8. 未决问题（如需 cc 确认）

1. **是否先 push 再部署**：cc 这次是先 commit 不 push 直接部署。你继承该策略就不 push，做完 v0.13.3 一起 push
2. **是否同时做 v0.14 Phase 1**：原计划 v0.14 brain-wiki.db 数据层的 Phase 1 规划已写在 `RETROSPECT-llmwiki-v0.13-direction.md` §8。修完 v0.13.3 后可以立即开 Phase 1
3. **是否需要 verification agent 对抗审核**：如果担心 DROP TRIGGER 顺序问题，可以让 `verification` subagent 审核 patch

---

## 9. 上个 session 的元认知笔记（给你避坑用）

cc 上 session 踩的坑：

1. **信 HANDOFF 字面 stack trace**：HANDOFF 说 `at loadBrainContext (brain-context.ts:358:3)` + `影响 chat 500`，实际 L358 只是 `await Promise.all`，错误被 try/catch 吞了，chat 实际 HTTP 200
2. **没先 ssh 拿生产实时 stack trace**：应该先 ssh studio 看 `~/.pm2/logs/brain-error.log` 的实时错误
3. **盲信 codex 的高置信度假设**：codex 假设 1/2 都指向 items_vec（float[768] vs 1024），但 Studio 上 sqlite-vec **根本没加载**，那条路径是死代码。假设 3（TRIGGER datatype mismatch）置信度标"中"反而才是对的
4. **没验证 sqlite-vec 是否加载**：先做 `ssh studio "tail pm2-out.log"` 拿 `[memory-db] sqlite-vec not available`，就知道 items_vec 方向是错的

**铁律**：**修生产 bug 前，先拿生产的实时 stack trace + 运行时状态，再写 patch**。

---

_HANDOFF 生成 by cc（claude-opus-4-6 1M）| 2026-04-11 22:01 CST_
_参考 commit：0d2f64e fix(brain): v0.13.2 SQLITE_MISMATCH 修复_
_诊断来源：codex rescue task-mnudgdv4-qk23ff + Explore agent a4bdeabec8a17ce98 + cc 生产实测（curl + ssh pm2 logs）_
