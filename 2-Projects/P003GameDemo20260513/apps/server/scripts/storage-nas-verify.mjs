// Filesystem-only verifier. On PRnas run in the existing pinned Node container
// with --network none, no capabilities, and only the archive directory mounted.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const keys = ['schema_version', 'archive_id', 'kind', 'created_at_ms', 'record_count', 'bytes', 'sha256', 'source_range'].sort();
const kinds = ['analytics_backup', 'ark_checkpoint', 'transfer_probe'];
const fail = message => { throw new Error(message); };
const regular = p => { const s = fs.lstatSync(p); if (!s.isFile() || s.isSymbolicLink()) fail('NOT_REGULAR'); return s; };
const exists = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const syncDir = p => { const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
function dir(p) {
  if (!exists(p)) fs.mkdirSync(p, { mode: 0o700 });
  const s = fs.lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink()) fail('UNSAFE_DIRECTORY');
}
function setup(root) {
  if (!path.isAbsolute(root) || fs.realpathSync(root) !== root) fail('UNSAFE_ROOT');
  for (const n of ['incoming', 'packages', 'quarantine', 'trash', 'restore', 'receipts']) dir(path.join(root, n));
}
function json(p) { if (regular(p).size > 8192) fail('MANIFEST_TOO_LARGE'); return JSON.parse(fs.readFileSync(p, 'utf8')); }
function durableJson(p, data) {
  const tmp = p + '.' + randomUUID(); const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p); syncDir(path.dirname(p));
}
export function validate(m) {
  if (!m || Array.isArray(m) || Object.keys(m).sort().join(',') !== keys.join(',')) fail('INVALID_MANIFEST');
  if (m.schema_version !== 1 || typeof m.archive_id !== 'string' || !ID.test(m.archive_id) || !kinds.includes(m.kind)
      || typeof m.sha256 !== 'string' || !HASH.test(m.sha256)) fail('INVALID_MANIFEST');
  for (const k of ['bytes', 'record_count', 'created_at_ms']) if (!Number.isSafeInteger(m[k]) || m[k] < 0) fail('INVALID_NUMBER');
  if (!m.bytes || m.bytes > 256 * 1024 ** 3 || !m.source_range || Array.isArray(m.source_range)
      || typeof m.source_range !== 'object' || Buffer.byteLength(JSON.stringify(m)) > 8192) fail('INVALID_RANGE');
  return m;
}
function packagePath(root, id, staging = false) {
  if (!ID.test(id)) fail('INVALID_ID');
  const p = path.join(root, staging ? 'incoming' : 'packages', id);
  if (exists(p) && fs.lstatSync(p).isSymbolicLink()) fail('UNSAFE_DIRECTORY');
  return p;
}
async function checksum(p) {
  regular(p); const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(p)) hash.update(chunk);
  return hash.digest('hex');
}
async function verifyRows(m, payload) {
  if (m.kind !== 'analytics_backup') return;
  const tables = m.source_range.tables;
  if (!tables || Array.isArray(tables) || typeof tables !== 'object' || !Object.keys(tables).length || Object.keys(tables).length > 100) fail('INVALID_TABLE_COUNTS');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(payload, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA cache_size=-131072');
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') fail('SQLITE_INTEGRITY');
    let total = 0;
    for (const [name, expected] of Object.entries(tables)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || !Number.isSafeInteger(expected) || expected < 0) fail('INVALID_TABLE_COUNTS');
      const actual = db.prepare('SELECT count(1) AS n FROM "' + name + '" NOT INDEXED').get().n;
      if (actual !== expected) fail('ROW_COUNT_MISMATCH');
      total += actual;
    }
    if (total !== m.record_count) fail('ROW_COUNT_MISMATCH');
  } finally {
    db.close();
    // A closed Backup API image may retain WAL mode. SQLite's read-only open
    // creates empty WAL/SHM sidecars; they are not archival data.
    const wal=payload+'-wal',shm=payload+'-shm';
    if(exists(wal)&&regular(wal).size!==0)fail('UNEXPECTED_ARCHIVE_WAL');
    for(const p of [shm,wal])if(exists(p)){regular(p);fs.unlinkSync(p);}
  }
}
function equalManifest(a, b) {
  // Remote manifests are immutable and serialized deterministically by the gateway.
  if (JSON.stringify(a) !== JSON.stringify(b)) fail('MANIFEST_CHANGED');
}
function quarantine(root, stage, id) {
  fs.renameSync(stage, path.join(root, 'quarantine', id + '-' + randomUUID()));
  syncDir(path.join(root, 'incoming')); syncDir(path.join(root, 'quarantine'));
}
function usedBytes(p) {
  const s=fs.lstatSync(p);if(s.isSymbolicLink())return s.size; // Account for the link itself, never follow it.
  if(s.isFile())return s.size;
  if(!s.isDirectory())fail('NOT_REGULAR');
  return fs.readdirSync(p).reduce((sum,n)=>sum+usedBytes(path.join(p,n)),0);
}
function space(root, additional, options={}) {
  const budget=options.budgetBytes??Number(process.env.ARCHIVE_NAS_BUDGET_BYTES??1024**4);
  const reserve=options.reserveBytes??Number(process.env.ARCHIVE_NAS_RESERVE_BYTES??4*1024**3);
  if(!Number.isSafeInteger(budget)||budget<1||!Number.isSafeInteger(reserve)||reserve<0)fail('INVALID_BUDGET');
  if(usedBytes(root)+additional>budget)fail('NAS_BUDGET_EXCEEDED');
  const stat=fs.statfsSync(root);if(stat.bavail*stat.bsize<additional+reserve)fail('NAS_SPACE_INSUFFICIENT');
}
export function prepare(root, manifestFile, options={}) {
  setup(root); const m = validate(json(manifestFile));
  const final = packagePath(root, m.archive_id);
  if (exists(final)) {
    equalManifest(validate(json(path.join(final, 'manifest.json'))), m);
    if (regular(path.join(final, 'payload.bin')).size !== m.bytes) fail('FINAL_SIZE_MISMATCH');
    return { ...m, offset: m.bytes, complete: true, payload: path.join(final, 'payload.bin') };
  }
  const stage = packagePath(root, m.archive_id, true);
  const existing=exists(path.join(stage,'payload.bin'))?regular(path.join(stage,'payload.bin')).size:0;
  space(root,Math.max(0,m.bytes-existing),options);dir(stage);
  const localManifest = path.join(stage, 'manifest.json');
  if (exists(localManifest)) equalManifest(validate(json(localManifest)), m);
  else durableJson(localManifest, m);
  const payload = path.join(stage, 'payload.bin');
  if (!exists(payload)) { const fd = fs.openSync(payload, 'wx', 0o600); fs.closeSync(fd); }
  const offset = regular(payload).size;
  if (offset > m.bytes) { quarantine(root, stage, m.archive_id); fail('PARTIAL_OVERSIZE'); }
  return { ...m, offset, complete: false, payload };
}
export async function finalize(root, id) {
  setup(root); const final = packagePath(root, id); const stage = packagePath(root, id, true);
  const folder = exists(final) ? final : stage;
  const m = validate(json(path.join(folder, 'manifest.json')));
  if (m.archive_id !== id) fail('MANIFEST_ID_MISMATCH');
  const p = path.join(folder, 'payload.bin');
  if (regular(p).size !== m.bytes || await checksum(p) !== m.sha256) {
    if (folder === stage) {
      quarantine(root, stage, id);
    }
    fail('CHECKSUM_MISMATCH');
  }
  await verifyRows(m, p);
  // Repeat durability barriers after restart/ACK loss, including a previous
  // rename that succeeded just before its directory fsync failed.
  for (const file of ['payload.bin', 'manifest.json']) {
    const fd = fs.openSync(path.join(folder, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  syncDir(folder);
  if (folder === stage) {
    fs.renameSync(stage, final);
  }
  syncDir(path.join(root, 'incoming')); syncDir(path.join(root, 'packages')); syncDir(root);
  return m;
}
export function acknowledge(root, id, receipt) {
  setup(root); const folder = packagePath(root, id); const m = validate(json(path.join(folder, 'manifest.json')));
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'archive_id,bytes,record_count,sha256,verified_at_ms'
      || receipt.archive_id !== id || receipt.sha256 !== m.sha256 || receipt.bytes !== m.bytes || receipt.record_count !== m.record_count
      || !Number.isSafeInteger(receipt.verified_at_ms) || receipt.verified_at_ms < 0) fail('ACK_MISMATCH');
  durableJson(path.join(folder, 'receipt.json'), receipt);
  durableJson(path.join(root,'receipts',id+'.json'),receipt);
}
function receiptFor(root,m) {
  let file=path.join(packagePath(root,m.archive_id),'receipt.json');
  if(!exists(file))file=path.join(root,'receipts',m.archive_id+'.json');
  if(!exists(file))return null;
  const r=json(file);
  if(['archive_id','sha256','bytes','record_count'].some(k=>r[k]!==m[k])||!Number.isSafeInteger(r.verified_at_ms))fail('ACK_MISMATCH');
  return r;
}
export function queue(root,listFile) {
  setup(root);regular(listFile);
  if(fs.statSync(listFile).size>4*1024**2)fail('LIST_TOO_LARGE');
  const list=JSON.parse(fs.readFileSync(listFile,'utf8'));if(!Array.isArray(list)||list.length>10000)fail('INVALID_LIST');
  // Receipts prove this exact immutable payload was already finalized and acknowledged.
  const merged=new Map(list.map(m=>[validate(m).archive_id,m]));
  // Recover ACK-loss even if the cloud already garbage-collected an old payload.
  for(const id of fs.readdirSync(path.join(root,'packages'))){
    const m=validate(json(path.join(packagePath(root,id),'manifest.json')));
    if(m.archive_id!==id)fail('MANIFEST_ID_MISMATCH');
    if(!merged.has(id)&&!receiptFor(root,m))merged.set(id,m);
  }
  return [...merged.values()].filter(m=>!receiptFor(root,m)).sort((a,b)=>a.created_at_ms-b.created_at_ms).slice(0,20).map(m=>m.archive_id);
}
async function restoreCheck(root,m,options) {
  const folder=path.join(root,'restore'),file=path.join(folder,'latest.sqlite3'),record=path.join(folder,'latest.json');
  const marker=exists(record)?json(record):null;
  if(marker?.archive_id===m.archive_id&&marker?.sha256===m.sha256&&exists(file)&&regular(file).size===m.bytes)return marker;
  const temp=path.join(folder,'next.partial');
  if(exists(temp)){regular(temp);fs.unlinkSync(temp);}
  space(root,m.bytes,options);
  const source=path.join(packagePath(root,m.archive_id),'payload.bin');
  if(regular(source).size!==m.bytes||await checksum(source)!==m.sha256)fail('RESTORE_CHECKSUM');
  fs.copyFileSync(source,temp,fs.constants.COPYFILE_EXCL);
  if(await checksum(temp)!==m.sha256)fail('RESTORE_CHECKSUM');
  await verifyRows(m,temp);
  const fd=fs.openSync(temp,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);syncDir(folder);
  const result={archive_id:m.archive_id,sha256:m.sha256,bytes:m.bytes,record_count:m.record_count,integrity_check:'ok'};
  durableJson(record,result);return result;
}
function deleteTrash(root) {
  for(const id of fs.readdirSync(path.join(root,'trash'))) {
    if(!ID.test(id))fail('INVALID_TRASH');
    const folder=path.join(root,'trash',id);dir(folder);
    const files=fs.readdirSync(folder);
    if(files.some(n=>!['payload.bin','manifest.json','receipt.json','payload.bin-wal','payload.bin-shm'].includes(n)))fail('UNEXPECTED_TRASH_CONTENT');
    const wal=path.join(folder,'payload.bin-wal');if(exists(wal)&&regular(wal).size!==0)fail('UNEXPECTED_ARCHIVE_WAL');
    if(exists(path.join(folder,'receipt.json')))durableJson(path.join(root,'receipts',id+'.json'),json(path.join(folder,'receipt.json')));
    for(const n of files){const p=path.join(folder,n);regular(p);fs.unlinkSync(p);}
    fs.rmdirSync(folder);
  }
  syncDir(path.join(root,'trash'));
}
export async function rotateBackups(root,options={}) {
  setup(root);deleteTrash(root);
  const all=fs.readdirSync(path.join(root,'packages')).map(id=>{
    if(!ID.test(id))fail('INVALID_PACKAGE');const m=validate(json(path.join(packagePath(root,id),'manifest.json')));
    if(m.archive_id!==id)fail('MANIFEST_ID_MISMATCH');return m;
  });
  const backups=all.filter(m=>m.kind==='analytics_backup'&&receiptFor(root,m)).sort((a,b)=>b.created_at_ms-a.created_at_ms||b.archive_id.localeCompare(a.archive_id));
  if(!backups.length)return {kept:[],removed:[],restore:null};
  // Distinct CST calendar days and Monday-based weeks, newest representative per bucket.
  const keep=new Set(),days=new Set(),weeks=new Set();
  for(const m of backups){
    const day=Math.floor((m.created_at_ms+8*3600000)/86400000),week=Math.floor((day+3)/7);
    if(days.size<7&&!days.has(day)){days.add(day);keep.add(m.archive_id);}
    if(weeks.size<4&&!weeks.has(week)){weeks.add(week);keep.add(m.archive_id);}
  }
  const restore=await restoreCheck(root,backups[0],options);
  const removed=[];
  for(const m of backups){
    if(keep.has(m.archive_id))continue;
    const folder=packagePath(root,m.archive_id);
    durableJson(path.join(root,'receipts',m.archive_id+'.json'),receiptFor(root,m));
    fs.renameSync(folder,path.join(root,'trash',m.archive_id));syncDir(path.join(root,'packages'));syncDir(path.join(root,'trash'));
    removed.push(m.archive_id);
  }
  deleteTrash(root);
  const result={kept:[...keep],removed,restore,last_offsite_backup_ms:backups[0].created_at_ms,
    offsite_age_ms:Math.max(0,(options.nowMs??Date.now())-backups[0].created_at_ms)};
  durableJson(path.join(root,'retention-status.json'),result);return result;
}
export function cycleStatus(root,exit,phase) {
  setup(root);
  if(!Number.isInteger(exit)||exit<0||exit>255||!['list','transfer','rotate','complete'].includes(phase))fail('INVALID_STATUS');
  const file=path.join(root,'cycle-status.json'),old=exists(file)?json(file):{};
  const value={last_attempt_ms:Date.now(),exit,phase,last_success_ms:exit===0?Date.now():(old.last_success_ms??null),
    connection:phase==='list'&&exit!==0?'unreachable':(exit===0?'connected':'not_proven')};
  durableJson(file,value);return value;
}
async function main() {
  const [command, root, arg, extra] = process.argv.slice(2);
  if (command === 'prepare') {
    const m = prepare(root, arg);
    console.log([m.archive_id, m.sha256, m.bytes, m.offset, m.complete ? 1 : 0, m.record_count].join('\t'));
  } else if (command === 'finalize') console.log(JSON.stringify(await finalize(root, arg)));
  else if (command === 'ack') { acknowledge(root, arg, json(extra)); console.log('ACK_STORED'); }
  else if (command === 'queue') { for(const id of queue(root,arg))console.log(id); }
  else if (command === 'rotate') console.log(JSON.stringify(await rotateBackups(root)));
  else if (command === 'status') console.log(JSON.stringify(cycleStatus(root,Number(arg),extra)));
  else fail('INVALID_COMMAND');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('ARCHIVE_VERIFY_FAILED:' + e.message); process.exitCode = 1; });
}
