-- 小可夜航 (night) 设备诊断库 schema —— 与 night_server.py 中的 SCHEMA_SQL 一致。
-- 说明：这里只有技术事件，没有原话、没有密钥、没有 Authorization。
-- 幂等键是 (device, id)，重复批次不会多记一行。

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS events (
    device       TEXT    NOT NULL,        -- 允许表里的设备标识，例如 phone-01
    id           TEXT    NOT NULL,        -- 客户端事件 UUID/短 id，1..64 位 [A-Za-z0-9._:-]
    kind         TEXT    NOT NULL,        -- 13 类白名单之一
    ts           INTEGER NOT NULL,        -- 客户端事件时间戳（epoch 秒）
    version_code INTEGER NOT NULL,        -- App versionCode
    received_at  INTEGER NOT NULL,        -- 服务端落库时间（epoch 秒）
    PRIMARY KEY (device, id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_events_received    ON events(received_at);
CREATE INDEX IF NOT EXISTS idx_events_ts          ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts     ON events(kind, ts);

-- 批次留痕：只记批次摘要与条数，便于核对客户端是否有重放/丢批。
CREATE TABLE IF NOT EXISTS ingest (
    batch_id     TEXT PRIMARY KEY,        -- sha256(device \0 id1,id2,...)[:32]
    device       TEXT NOT NULL,
    events       INTEGER NOT NULL,        -- 本次请求声明的条数（去重前）
    inserted     INTEGER NOT NULL,        -- 实际新增行数（去重后）
    repeats      INTEGER NOT NULL DEFAULT 1,  -- 同一批次签名的到达次数（>1 说明客户端重放了）
    received_at  INTEGER NOT NULL
);

-- 裁剪：events 按 received_at 保留 NIGHT_RETENTION_DAYS（默认 45 天），
-- 并保证总行数不超过 NIGHT_MAX_ROWS（默认 500000）；ingest 同步按天裁剪。

-- 配对设备的前台状态、配色修订和最新维护请求。
CREATE TABLE IF NOT EXISTS mobile_devices (
 device TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'idle',
 muted INTEGER NOT NULL DEFAULT 0, accent TEXT, revision INTEGER NOT NULL DEFAULT 0,
 applied INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0,
 cmd TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '',
 created INTEGER NOT NULL DEFAULT 0, acked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_device_time ON events(device,ts DESC);
