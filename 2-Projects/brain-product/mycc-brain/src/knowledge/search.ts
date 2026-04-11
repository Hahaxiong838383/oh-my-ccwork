/**
 * search.ts — 外挂知识系统的"第五路检索"入口
 *
 * 设计纲领：
 *   - **默认 off**：`KNOWLEDGE_SEARCH_ENABLED !== 'true'` 时直接返回 []，不开 DB。
 *   - **关键词触发白名单**：只有 query 命中文档/SOP/流程类意图时才触发。
 *   - **模块级懒加载 singleton**：首次调用时打开 knowledge.db，进程退出前复用。
 *   - **失败静默**：DB 打不开 / 查询抛错 → 返回 []，不影响原四路检索。
 *   - **readonly immutable**：不 mutate 入参，返回 readonly 数组。
 *
 * 由 brain-context.ts 的主检索编排函数在四路完成后追加调用，
 * 结果以 `knowledge` 独立字段合并到 BrainContextResult，不污染现有统计。
 */
import path from "path";
import {
  openKnowledgeDB,
  closeKnowledgeDB,
  knowledgeFtsSearch,
  type KnowledgeDatabase,
} from "./store.js";
import type { KnowledgeSearchHit } from "./types.js";

/** 触发第五路检索的关键词白名单 */
const TRIGGER_PATTERNS: readonly RegExp[] = [
  /文档|wiki|手册|sop|规范/i,
  /怎么部署|怎么使用|怎么配置|如何操作|如何配置/,
  /流程|步骤|操作方法|指南/,
];

/**
 * 判断 query 是否应该触发知识库检索。
 *
 * - `KNOWLEDGE_SEARCH_ENABLED !== 'true'` → 直接 false（全局开关）
 * - 命中任一 TRIGGER_PATTERNS → true
 * - 否则 false
 */
export function shouldTriggerKnowledgeSearch(query: string): boolean {
  if (process.env.KNOWLEDGE_SEARCH_ENABLED !== "true") return false;
  for (const p of TRIGGER_PATTERNS) {
    if (p.test(query)) return true;
  }
  return false;
}

// ─── 模块级 singleton cache ───

interface CachedDb {
  readonly path: string;
  readonly db: KnowledgeDatabase;
}

let _cached: CachedDb | null = null;

/** 进程退出前释放 cached DB（只挂一次 hook） */
let _exitHookInstalled = false;
function installExitHook(): void {
  if (_exitHookInstalled) return;
  _exitHookInstalled = true;
  const release = (): void => {
    if (_cached) {
      try {
        closeKnowledgeDB(_cached.db);
      } catch {
        /* ignore */
      }
      _cached = null;
    }
  };
  process.once("exit", release);
  process.once("SIGINT", release);
  process.once("SIGTERM", release);
}

function resolveDbPath(explicit?: string): string {
  if (explicit) return explicit;
  const envPath = process.env.KNOWLEDGE_DB_PATH;
  if (envPath) return envPath;
  const dataDir = process.env.DATA_DIR ?? ".";
  return path.join(dataDir, "knowledge.db");
}

async function getOrOpenDb(dbPath: string): Promise<KnowledgeDatabase | null> {
  if (_cached && _cached.path === dbPath) return _cached.db;

  // path 切换时释放旧 db（主要服务测试场景）
  if (_cached) {
    try {
      closeKnowledgeDB(_cached.db);
    } catch {
      /* ignore */
    }
    _cached = null;
  }

  const db = await openKnowledgeDB(dbPath);
  if (!db) {
    console.error(`[knowledge-search] failed to open db: ${dbPath}`);
    return null;
  }
  _cached = { path: dbPath, db };
  installExitHook();
  return db;
}

/** 测试钩子：关闭 cached db 并清空 singleton */
export function resetKnowledgeSearchCache(): void {
  if (_cached) {
    try {
      closeKnowledgeDB(_cached.db);
    } catch {
      /* ignore */
    }
    _cached = null;
  }
}

/**
 * 第五路检索：外挂知识库 FTS5 召回。
 *
 * @param query  用户查询
 * @param topK   最多返回条数（默认 5）
 * @param options.forceEnable  跳过触发器判断，直接查询（测试用）
 * @param options.dbPath       指定 db 路径（测试用）
 * @returns readonly 命中数组；任何失败路径都返回 []
 */
export async function knowledgeSearch(
  query: string,
  topK?: number,
  options?: { readonly forceEnable?: boolean; readonly dbPath?: string },
): Promise<readonly KnowledgeSearchHit[]> {
  if (!options?.forceEnable && !shouldTriggerKnowledgeSearch(query)) {
    return [];
  }

  const dbPath = resolveDbPath(options?.dbPath);

  try {
    const db = await getOrOpenDb(dbPath);
    if (!db) return [];
    const hits = knowledgeFtsSearch(db, query, topK ?? 5);
    return hits;
  } catch (err) {
    console.error("[knowledge-search] query failed:", err);
    return [];
  }
}
