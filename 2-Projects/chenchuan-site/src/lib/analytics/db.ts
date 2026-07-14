import 'server-only'
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// SQLite 单例 + WAL 模式（高并发安全 + 主线程不阻塞）
// 数据文件：data/analytics.db（生产环境 /var/www/chenchuan-site/data/analytics.db）
// 90 天滚动保留：每次开 DB 启动时清理超期记录

const DB_PATH = process.env.ANALYTICS_DB_PATH ?? resolve(process.cwd(), 'data/analytics.db')
const RETENTION_DAYS = 90

let dbInstance: Database.Database | null = null

function initDb(): Database.Database {
  // 确保父目录存在
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true })
  } catch {
    // 已存在则忽略
  }

  const db = new Database(DB_PATH)
  // WAL 模式：写入不阻塞读取，并发性能更好
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  // visits 表：每行一次访问
  // ip_hash: 保留做 UV 计数（去重）
  // ip: 明文 IP，用于后台展示来源详情（管理员视图独占）
  db.exec(`
    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      path TEXT NOT NULL,
      referrer TEXT,
      ip_hash TEXT NOT NULL,
      ip TEXT,
      ua TEXT,
      country TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts);
    CREATE INDEX IF NOT EXISTS idx_visits_path ON visits(path);
    CREATE INDEX IF NOT EXISTS idx_visits_country ON visits(country);
  `)

  // === ai-os/chat 1.0 ===
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_quota (
      cookie_id TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      PRIMARY KEY (cookie_id, ip_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_quota_ip ON chat_quota(ip_hash);
    CREATE INDEX IF NOT EXISTS idx_chat_quota_last_at ON chat_quota(last_at);

    CREATE TABLE IF NOT EXISTS daily_budget (
      date TEXT PRIMARY KEY,
      cents_used INTEGER NOT NULL DEFAULT 0,
      cents_cap INTEGER NOT NULL DEFAULT 1000,
      alert_50_sent BOOL DEFAULT FALSE,
      alert_80_sent BOOL DEFAULT FALSE,
      alert_100_sent BOOL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS chat_blacklist (
      ip_hash TEXT PRIMARY KEY,
      reason TEXT,
      banned_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_blacklist_expires_at ON chat_blacklist(expires_at);

    CREATE TABLE IF NOT EXISTS classic_demos (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      question TEXT NOT NULL,
      routing TEXT NOT NULL,
      featured INTEGER DEFAULT 0,
      quality_score INTEGER DEFAULT 50,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_classic_demos_category ON classic_demos(category);
    CREATE INDEX IF NOT EXISTS idx_classic_demos_featured ON classic_demos(featured);
    CREATE INDEX IF NOT EXISTS idx_classic_demos_quality ON classic_demos(quality_score);

    -- 视频库管理（/admin/videos 编辑，公开 /videos + 首页 VideoSection 读 published=1）
    CREATE TABLE IF NOT EXISTS managed_videos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      url TEXT NOT NULL,
      thumbnail TEXT,
      duration TEXT,
      tags TEXT,                     -- JSON 数组字符串
      project_slug TEXT,             -- 关联项目（projects.ts 的 slug），空=独立视频
      published INTEGER DEFAULT 1,   -- 上架=1 / 下架=0（软下架，比硬删稳）
      sort INTEGER DEFAULT 0,        -- 升序，越小越靠前
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_managed_videos_published ON managed_videos(published);
    CREATE INDEX IF NOT EXISTS idx_managed_videos_sort ON managed_videos(sort);

    -- 首页 / AI 对话页的 MyJavis 公开语音体验。只存匿名标识和会话元数据，不存录音或转写。
    CREATE TABLE IF NOT EXISTS voice_experience_usage (
      visitor_id TEXT NOT NULL,
      cookie_hash TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      date TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      last_at INTEGER NOT NULL,
      PRIMARY KEY (visitor_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_voice_usage_ip_date ON voice_experience_usage(ip_hash, date);

    CREATE TABLE IF NOT EXISTS voice_experience_codes (
      code_hash TEXT PRIMARY KEY,
      code_hint TEXT NOT NULL,
      label TEXT,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_voice_codes_created ON voice_experience_codes(created_at DESC);

    CREATE TABLE IF NOT EXISTS voice_experience_sessions (
      id TEXT PRIMARY KEY,
      visitor_id TEXT NOT NULL,
      cookie_hash TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      source TEXT NOT NULL,
      code_hash TEXT,
      room_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      stopped_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_voice_sessions_visitor ON voice_experience_sessions(visitor_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_voice_sessions_status ON voice_experience_sessions(status, expires_at);
  `)

  // 兼容已有 DB：检查 ip 列是否存在，没有则 ALTER TABLE 加上
  const cols = db.prepare("PRAGMA table_info(visits)").all() as Array<{ name: string }>
  if (!cols.find((c) => c.name === 'ip')) {
    db.exec('ALTER TABLE visits ADD COLUMN ip TEXT')
  }

  // 启动时清理超过 90 天的记录
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  db.prepare('DELETE FROM visits WHERE ts < ?').run(cutoff)

  return db
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    dbInstance = initDb()
  }
  return dbInstance
}

// 进程退出时关闭 DB（防 WAL checkpoint 丢失）
if (typeof process !== 'undefined') {
  process.on('beforeExit', () => {
    if (dbInstance) {
      dbInstance.close()
      dbInstance = null
    }
  })
}
