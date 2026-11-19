#!/usr/bin/env node
'use strict'

// Usage: node scripts/update-video-copy-20260914.cjs <prepare|apply|verify|rollback> DB BACKUP_DIR
// prepare only changes a consistent backup copy. apply/rollback update nine descriptions by CAS.
// The full SQLite backup is retained for recovery evidence; rollback NEVER restores the whole DB.
// Self-test: node scripts/update-video-copy-20260914.cjs self-test
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { execFileSync } = require('node:child_process')

process.umask(0o077)
const MIGRATION = 'video-copy-20260914'
const RECORD_NAME = `${MIGRATION}.before-after.json`
const SNAPSHOT_NAME = `${MIGRATION}.before.sqlite`
const PATCHES = [
  ['rk3588-edge-multimodal',
    '基于 RK3588 部署端侧多模态模型，采用 InspireFace 检测级联 HSEmotion-b2 表情识别，在本地实现毫秒级表情、坐姿等状态识别与实时反馈。',
    '在 RK3588 上运行 InspireFace 检测与 HSEmotion-b2 表情识别，演示本地表情、坐姿状态识别与反馈。'],
  ['full-duplex-streaming-voice-agent',
    '展示 AI Agent 与用户进行全双工、双向流式实时语音对话的实际体验，包括连续交流、实时响应与自然打断。',
    '全双工、双向流式语音对话演示，记录连续交流和用户打断时的响应。'],
  ['multimodal-gaze-tracking-20260722',
    '与此前多模态视觉交互演示同源，本段更聚焦视线追踪链路优化，展示注视点定位、跟随稳定性与多模态协同交互效果。',
    '此前多模态视觉交互原型的后续演示，重点观察注视点定位、跟随稳定性与多模态操作的配合。'],
  ['eye-1',
    '基于 FaceMesh 眼动追踪与手势识别的多模态交互原型，展示注视预选与捏住抓取的融合交互。',
    '使用 FaceMesh 与手势识别，演示注视预选和捏合抓取。'],
  ['eye-2',
    '注视高亮蹦跳效果与捏住优先抓取机制的联动演示，实现自然直觉的空间交互体验。',
    '展示注视高亮、气泡反馈与捏合抓取的配合。'],
  ['eye-3',
    '气泡锁定与视觉增强效果，通过校准精度优化实现精准的注视-手势协同操作。',
    '展示校准后的注视点、气泡锁定与手势操作效果。'],
  ['eye-4',
    '完整展示从注视预选到手势确认的多模态交互全流程，包括眼动校准、气泡识别与拖拽操作。',
    '记录眼动校准、注视预选、手势确认与拖拽操作的连续流程。'],
  ['full-window-hud-live',
    '全车窗 HUD 概念车实拍——整块前挡风玻璃化作 AR 显示屏，导航、预警、信息分区呈现。',
    '全车窗 HUD 概念车实拍，展示前挡风玻璃上的导航、预警与分区信息。'],
  ['mass-production-hud',
    '量产级 AR HUD 与全车窗显示产品全景演示，涵盖多场景信息叠加与人机交互。',
    '量产 AR HUD 的信息叠加演示，以及全车窗显示概念展示。未来 5.0 系列仍在预研，不属于本视频的量产成果。'],
].map(([id, before, after]) => ({ id, before, after }))
const TARGET_IDS = new Set(PATCHES.map((entry) => entry.id))
let Database

function openDatabase(dbPath, readonly = false) {
  if (!Database) {
    // A rollback copy of this script may live outside the application/dependencies directory.
    const sitePackage = path.join(path.dirname(path.dirname(dbPath)), 'package.json')
    try {
      Database = createRequire(sitePackage)('better-sqlite3')
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
      Database = require('better-sqlite3')
    }
  }
  return new Database(dbPath, { readonly, fileMustExist: true, timeout: 10000 })
}

function currentRows(db) {
  const select = db.prepare('SELECT id, title, description FROM managed_videos WHERE id = ?')
  return PATCHES.map(({ id }) => select.get(id))
}

function assertDescriptions(db, direction) {
  const rows = currentRows(db)
  const conflicts = PATCHES.filter((entry, index) => !rows[index] || rows[index].description !== entry[direction])
  if (conflicts.length) throw new Error(`DESCRIPTION_CONFLICT (${direction}): ${conflicts.map((entry) => entry.id).join(', ')}`)
  return rows
}

function hasDescriptions(db, direction) {
  const rows = currentRows(db)
  return PATCHES.every((entry, index) => rows[index] && rows[index].description === entry[direction])
}

function videoInvariant(db) {
  // Detect triggers or accidental changes to timestamps, ordering, media and unrelated videos.
  return JSON.stringify(db.prepare('SELECT * FROM managed_videos ORDER BY id').all().map((row) =>
    TARGET_IDS.has(row.id) ? { ...row, description: '<managed-description>' } : row))
}

function writeRecord(filename, data) {
  const fd = fs.openSync(filename, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function readRecord(backupDir) {
  const filename = path.join(backupDir, RECORD_NAME)
  if (!fs.existsSync(filename)) return null
  const record = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (record.migration !== MIGRATION || record.schemaVersion !== 1 || !Array.isArray(record.targets) || record.targets.length !== PATCHES.length) {
    throw new Error('INVALID_MIGRATION_RECORD')
  }
  const ids = new Set()
  for (const row of record.targets) {
    const expected = PATCHES.find((entry) => entry.id === row.id)
    if (!expected || ids.has(row.id) || row.before !== expected.before || row.after !== expected.after) {
      throw new Error('INVALID_MIGRATION_TARGETS')
    }
    ids.add(row.id)
  }
  return record
}

async function withBackupLock(backupDir, action) {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const lockPath = path.join(backupDir, `${MIGRATION}.lock`)
  const lock = fs.openSync(lockPath, 'wx', 0o600)
  try {
    return await action()
  } finally {
    fs.closeSync(lock)
    fs.unlinkSync(lockPath)
  }
}

function changeDescriptions(db, direction, recordPath) {
  const from = direction === 'after' ? 'before' : 'after'
  const update = db.prepare('UPDATE managed_videos SET description = ? WHERE id = ? AND description IS ?')
  db.transaction(() => {
    const rows = assertDescriptions(db, from)
    const invariant = videoInvariant(db)
    if (recordPath) {
      // Persist only publicly visible fields. No analytics, sessions or user data enter this JSON.
      writeRecord(recordPath, {
        schemaVersion: 1,
        migration: MIGRATION,
        createdAt: new Date().toISOString(),
        targets: PATCHES.map((entry, index) => ({ id: entry.id, title: rows[index].title, before: entry.before, after: entry.after })),
      })
    }
    for (const entry of PATCHES) {
      const result = update.run(entry[direction], entry.id, entry[from])
      if (result.changes !== 1) throw new Error(`CAS_UPDATE_FAILED: ${entry.id}`)
    }
    assertDescriptions(db, direction)
    if (videoInvariant(db) !== invariant) throw new Error('NON_DESCRIPTION_CHANGE_DETECTED')
  }).immediate()
}

async function apply(dbPath, backupDir) {
  return withBackupLock(backupDir, async () => {
    const db = openDatabase(dbPath)
    try {
      const existing = readRecord(backupDir)
      if (existing) {
        if (!hasDescriptions(db, 'after')) throw new Error('BACKUP_ALREADY_USED: inspect this record or supply a fresh backup directory')
        return { mode: 'apply', ok: true, state: 'already-applied', targets: PATCHES.length }
      }
      assertDescriptions(db, 'before')
      const snapshot = path.join(backupDir, SNAPSHOT_NAME)
      if (fs.existsSync(snapshot)) throw new Error('SNAPSHOT_ALREADY_EXISTS: do not overwrite recovery evidence')
      await db.backup(snapshot)
      fs.chmodSync(snapshot, 0o600)
      // Re-read under BEGIN IMMEDIATE after backup: concurrent description edits become conflicts.
      changeDescriptions(db, 'after', path.join(backupDir, RECORD_NAME))
      return { mode: 'apply', ok: true, state: 'applied', targets: PATCHES.length, snapshot }
    } finally {
      db.close()
    }
  })
}

function verify(dbPath, backupDir, direction = 'after') {
  if (direction === 'after' && !readRecord(backupDir)) throw new Error('MIGRATION_RECORD_MISSING')
  const db = openDatabase(dbPath, true)
  try {
    assertDescriptions(db, direction)
    return { mode: 'verify', ok: true, state: direction, targets: PATCHES.length }
  } finally {
    db.close()
  }
}

async function rollback(dbPath, backupDir) {
  if (!readRecord(backupDir)) return { mode: 'rollback', ok: true, state: 'not-applied', targets: 0 }
  return withBackupLock(backupDir, async () => {
    // Revalidate the exact nine-target record after acquiring the lock.
    if (!readRecord(backupDir)) throw new Error('MIGRATION_RECORD_MISSING')
    const db = openDatabase(dbPath)
    try {
      if (hasDescriptions(db, 'before')) return { mode: 'rollback', ok: true, state: 'already-before', targets: PATCHES.length }
      changeDescriptions(db, 'before')
      return { mode: 'rollback', ok: true, state: 'rolled-back', targets: PATCHES.length }
    } finally {
      db.close()
    }
  })
}

async function prepare(dbPath, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  const tempDir = fs.mkdtempSync(path.join(backupDir, 'prepare-'))
  const copiedDb = path.join(tempDir, 'snapshot.sqlite')
  const source = openDatabase(dbPath, true)
  let expectedInvariant
  try {
    assertDescriptions(source, 'before')
    await source.backup(copiedDb)
    fs.chmodSync(copiedDb, 0o600)
  } finally {
    source.close()
  }
  const copy = openDatabase(copiedDb, true)
  try {
    assertDescriptions(copy, 'before')
    expectedInvariant = videoInvariant(copy)
  } finally {
    copy.close()
  }
  const rehearsalDir = path.join(tempDir, 'rehearsal')
  await apply(copiedDb, rehearsalDir)
  verify(copiedDb, rehearsalDir)
  await rollback(copiedDb, rehearsalDir)
  verify(copiedDb, rehearsalDir, 'before')
  const restored = openDatabase(copiedDb, true)
  try {
    assert.equal(videoInvariant(restored), expectedInvariant, 'rehearsal must preserve every other video field')
  } finally {
    restored.close()
  }
  const report = { mode: 'prepare', ok: true, targets: PATCHES.length, sourceOpenedReadOnly: true, applyVerified: true, rollbackVerified: true, tempDir }
  writeRecord(path.join(tempDir, 'verification.json'), report)
  return report
}

async function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chenchuan-video-copy-test-'))
  const dbPath = path.join(root, 'fixture.sqlite')
  Database = require('better-sqlite3')
  const fixture = new Database(dbPath)
  fixture.pragma('journal_mode = WAL')
  fixture.exec(`CREATE TABLE managed_videos (
    id TEXT PRIMARY KEY, title TEXT, description TEXT, url TEXT, thumbnail TEXT, duration TEXT,
    tags TEXT, project_slug TEXT, published INTEGER, sort INTEGER, created_at INTEGER, updated_at INTEGER
  ); CREATE TABLE analytics_sentinel (id INTEGER PRIMARY KEY, value TEXT);`)
  const insert = fixture.prepare('INSERT INTO managed_videos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  PATCHES.forEach((entry, index) => insert.run(entry.id, `Public ${entry.id}`, entry.before, `/media/${entry.id}.mp4`, '/poster.jpg', '0:24', '[]', 'project', 1, index, 1000, 2000))
  insert.run('unrelated', 'Unrelated', 'Unrelated description', '/keep.mp4', '/keep.jpg', '1:00', '[]', null, 1, 99, 1000, 2000)
  fixture.prepare('INSERT INTO analytics_sentinel(value) VALUES (?)').run('before')
  const originalRows = fixture.prepare('SELECT * FROM managed_videos ORDER BY id').all()
  fixture.close()

  await prepare(dbPath, path.join(root, 'prepare'))
  let db = openDatabase(dbPath)
  assert.deepEqual(db.prepare('SELECT * FROM managed_videos ORDER BY id').all(), originalRows, 'prepare must not mutate source')
  db.close()
  const live = path.join(root, 'live')
  await apply(dbPath, live)
  verify(dbPath, live)
  assert.equal((await apply(dbPath, live)).state, 'already-applied')
  const record = readRecord(live)
  assert.deepEqual(Object.keys(record.targets[0]).sort(), ['after', 'before', 'id', 'title'])
  const snapshot = openDatabase(path.join(live, SNAPSHOT_NAME), true)
  assertDescriptions(snapshot, 'before')
  snapshot.close()

  db = openDatabase(dbPath)
  db.prepare('INSERT INTO analytics_sentinel(value) VALUES (?)').run('after')
  db.prepare('UPDATE managed_videos SET title = ?, updated_at = ? WHERE id = ?').run('Later title', 9999, 'eye-1')
  db.prepare('UPDATE managed_videos SET sort = ? WHERE id = ?').run(555, 'unrelated')
  db.prepare('UPDATE managed_videos SET description = ? WHERE id = ?').run('Later administrator edit', 'eye-2')
  const beforeConflict = db.prepare('SELECT * FROM managed_videos ORDER BY id').all()
  db.close()
  await assert.rejects(rollback(dbPath, live), /DESCRIPTION_CONFLICT/)
  db = openDatabase(dbPath)
  assert.deepEqual(db.prepare('SELECT * FROM managed_videos ORDER BY id').all(), beforeConflict, 'rollback conflict must change nothing')
  db.prepare('UPDATE managed_videos SET description = ? WHERE id = ?').run(PATCHES.find((entry) => entry.id === 'eye-2').after, 'eye-2')
  db.close()
  await rollback(dbPath, live)
  verify(dbPath, live, 'before')
  assert.equal((await rollback(dbPath, live)).state, 'already-before')
  assert.equal((await rollback(dbPath, path.join(root, 'never-applied'))).state, 'not-applied')
  db = openDatabase(dbPath)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM analytics_sentinel').get().n, 2)
  assert.deepEqual(db.prepare('SELECT title, updated_at FROM managed_videos WHERE id = ?').get('eye-1'), { title: 'Later title', updated_at: 9999 })
  assert.equal(db.prepare('SELECT sort FROM managed_videos WHERE id = ?').get('unrelated').sort, 555)
  db.prepare('UPDATE managed_videos SET description = ? WHERE id = ?').run('Concurrent edit before apply', 'eye-3')
  const beforeApplyConflict = db.prepare('SELECT * FROM managed_videos ORDER BY id').all()
  db.close()
  await assert.rejects(apply(dbPath, path.join(root, 'conflict')), /DESCRIPTION_CONFLICT/)
  db = openDatabase(dbPath)
  assert.deepEqual(db.prepare('SELECT * FROM managed_videos ORDER BY id').all(), beforeApplyConflict, 'apply conflict must change nothing')
  db.close()

  // Prove the deployment rollback layout: script outside the site, dependencies found via DB path.
  const fixtureSite = path.join(root, 'site')
  const uploadScripts = path.join(root, 'upload', 'scripts')
  fs.mkdirSync(path.join(fixtureSite, 'data'), { recursive: true })
  fs.mkdirSync(path.join(fixtureSite, 'node_modules'), { recursive: true })
  fs.mkdirSync(uploadScripts, { recursive: true })
  fs.writeFileSync(path.join(fixtureSite, 'package.json'), '{"private":true}\n', { mode: 0o600 })
  fs.symlinkSync(path.dirname(require.resolve('better-sqlite3/package.json')), path.join(fixtureSite, 'node_modules', 'better-sqlite3'), 'dir')
  const relocatedScript = path.join(uploadScripts, path.basename(__filename))
  const relocatedDb = path.join(fixtureSite, 'data', 'analytics.db')
  fs.copyFileSync(__filename, relocatedScript)
  const backupSource = openDatabase(path.join(live, SNAPSHOT_NAME), true)
  try {
    await backupSource.backup(relocatedDb)
  } finally {
    backupSource.close()
  }
  const relocatedRecord = path.join(root, 'relocated-record')
  for (const mode of ['prepare', 'apply', 'verify', 'rollback']) {
    const output = execFileSync(process.execPath, [relocatedScript, mode, relocatedDb, relocatedRecord], {
      cwd: uploadScripts, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' },
    })
    assert.equal(JSON.parse(output).ok, true, `relocated CLI ${mode}`)
  }
  return { mode: 'self-test', ok: true, targets: PATCHES.length, checks: ['read-only preparation', 'consistent backup', 'apply and verify', 'idempotency', 'description-only rollback', 'later analytics and metadata preserved', 'apply/rollback CAS conflicts', 'public-only manifest', 'relocated CLI resolves dependencies via DB site'], root }
}

async function main() {
  const [mode, rawDb, rawBackup] = process.argv.slice(2)
  if (mode === 'self-test' && !rawDb && !rawBackup) return selfTest()
  if (!['prepare', 'apply', 'verify', 'rollback'].includes(mode) || !rawDb || !rawBackup || process.argv.length !== 5) {
    throw new Error('Usage: node update-video-copy-20260914.cjs <prepare|apply|verify|rollback> DB BACKUP_DIR; or self-test')
  }
  const dbPath = path.resolve(rawDb)
  const backupDir = path.resolve(rawBackup)
  if (mode === 'prepare') return prepare(dbPath, backupDir)
  if (mode === 'apply') return apply(dbPath, backupDir)
  if (mode === 'verify') return verify(dbPath, backupDir)
  return rollback(dbPath, backupDir)
}

if (require.main === module) {
  main().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error(`[${MIGRATION}] ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { PATCHES, prepare, apply, verify, rollback }
