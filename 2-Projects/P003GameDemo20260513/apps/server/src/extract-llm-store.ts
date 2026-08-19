import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 记忆/onboarding 抽取 LLM 的运营配置（Worker Brain tab「记忆抽取 LLM」卡，2026-08-19）。
 *
 * 动机：抽取通道此前钉死在 env 分支里，gemini 代理死透后静默全灭数周（llm-extract.ts 顶部注释）。
 * 本 store 让 provider/model/URL/key 可在后台统一改，**写入即热生效（零重启）**——llm-extract
 * 每次调用经 getExtractLlmConfig() 取值，内存缓存由写路径同步刷新（单进程 pm2 fork，无跨进程失效问题）。
 *
 * 语义：单行配置（id=1）。provider='inherit' 或无行 = 跟随主对话 LLM_PROVIDER 的 env 映射（历史行为）。
 * key 安全：DB 与 .env.local 同机同权限级；GET 端点只回尾 4 位，日志绝不打 key。
 */

export type ExtractProvider = 'inherit' | 'deepseek' | 'minimax' | 'gemini-proxy' | 'volc-ark';

export const EXTRACT_PROVIDERS: ExtractProvider[] = ['inherit', 'deepseek', 'minimax', 'gemini-proxy', 'volc-ark'];

export type ExtractLlmRow = {
  provider: ExtractProvider;
  base_url: string; // 空 = 用该 provider 的 env/内置默认
  api_key: string; // 空 = 用该 provider 的 env key
  model: string; // 空 = 用该 provider 的 env/内置默认
  updated_at: number;
};

const DEFAULT_DB_PATH = './data/devices.db';

function resolveDbPath(): string {
  const raw = process.env.DEVICES_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

class ExtractLlmStore {
  private readonly db: DatabaseSync;
  /** 进程内缓存：读热路径（每次抽取）零 SQL；写路径同步刷新。null=已加载且无配置行。 */
  private cache: ExtractLlmRow | null | undefined; // undefined=未加载

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extract_llm_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        provider TEXT NOT NULL DEFAULT 'inherit',
        base_url TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /** 当前配置；无行返回 null（=跟随 env 历史行为）。 */
  get(): ExtractLlmRow | null {
    if (this.cache !== undefined) return this.cache;
    const row = this.db
      .prepare(`SELECT provider, base_url, api_key, model, updated_at FROM extract_llm_config WHERE id = 1`)
      .get() as ExtractLlmRow | undefined;
    this.cache = row && EXTRACT_PROVIDERS.includes(row.provider) ? row : row ? { ...row, provider: 'inherit' } : null;
    return this.cache;
  }

  /**
   * 保存（upsert 单行）。patch 语义：api_key 传 undefined = 保留旧值（前端「不回显不重传」）；
   * 传空串 = 显式清除（回落 env）。写后同步刷新缓存——热生效关键，绝不能漏（缓存不随写失效=卡死旧配置）。
   */
  set(input: { provider: ExtractProvider; base_url: string; model: string; api_key?: string }): ExtractLlmRow {
    const prev = this.get();
    const row: ExtractLlmRow = {
      provider: input.provider,
      base_url: input.base_url.trim(),
      model: input.model.trim(),
      api_key: input.api_key === undefined ? (prev?.api_key ?? '') : input.api_key.trim(),
      updated_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO extract_llm_config (id, provider, base_url, api_key, model, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, base_url=excluded.base_url,
           api_key=excluded.api_key, model=excluded.model, updated_at=excluded.updated_at`,
      )
      .run(row.provider, row.base_url, row.api_key, row.model, row.updated_at);
    this.cache = row;
    return row;
  }

  /** 清除配置（回落 env 历史行为）。 */
  clear(): void {
    this.db.exec(`DELETE FROM extract_llm_config WHERE id = 1`);
    this.cache = null;
  }
}

export const extractLlmStore = new ExtractLlmStore();
