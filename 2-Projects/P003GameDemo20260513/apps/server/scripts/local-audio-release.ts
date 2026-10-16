/** 受控发布工具：readOnly 模式不导入 store；所有写入须显式 bundle SHA、revision、维护进程授权。 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, sha256, validateClipBytes, validatePublicationItems, type LocalAudioItem } from '../src/local-audio-integrity.js';

type Identity = { sn: string; account_id: string; parent_account_id: string | null; created_at: number; updated_at: number; status: string };
type Bundle = { kind: 'p003-local-audio-release-v1'; prepared_at: string; device: Identity; relation_first_seen_at: number | null;
  base_revision: number; gen: { tier: string; traits: string }; items: LocalAudioItem[]; source_sha256: Record<string,string> };
const profilePath=resolve(process.env.PROFILE_DB_PATH || './data/profile.db');
const devicesPath=resolve(process.env.DEVICES_DB_PATH || './data/devices.db');
const audioRoot=resolve(process.env.LOCAL_AUDIO_DIR || './data/local-audio');
const sourceRoot=fileURLToPath(new URL('..',import.meta.url));
const identitySql='SELECT sn, account_id, parent_account_id, created_at, updated_at, status FROM device_registry';
function readDb(path:string) { const db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA busy_timeout=5000');return db; }
function relationAnchor(db:DatabaseSync, account:string):number|null {
  return (db.prepare('SELECT first_seen_at FROM relation_state WHERE account_id=?').get(account)?.first_seen_at as number|undefined) ?? null;
}
function readIdentity(db:DatabaseSync, suffix:string):Identity {
  if (!/^\d{8}$/.test(suffix)) fail('invalid_device_suffix');
  const rows=db.prepare(`${identitySql} WHERE substr(sn,-8)=?`).all(suffix) as Identity[];
  if(rows.length!==1) fail('device_not_unique');
  const row=rows[0];
  if(row.status!=='active' || !/^BJP003\d{14}$/.test(row.sn) || row.account_id!==`device-${row.sn}`) fail('device_not_active_or_bound');
  return row;
}
function sourceHashes() {
  return Object.fromEntries(['src/local-audio-store.ts','src/local-audio-integrity.ts','src/local-audio-generator.ts',
    'src/local-audio-device-reply.ts','src/local-audio-g1-settings.ts','scripts/local-audio-release.ts']
    .map(p=>[p,sha256(readFileSync(resolve(sourceRoot,p)))]));
}
function regularBytes(p:string):Buffer {
  if(!lstatSync(p).isFile()) fail('not_regular_file');
  return readFileSync(p);
}
function validateBundleShape(b:Bundle) {
  if(b?.kind!=='p003-local-audio-release-v1' || !b.device || !/^BJP003\d{14}$/.test(b.device.sn)
    || b.device.account_id!==`device-${b.device.sn}` || !Number.isSafeInteger(b.base_revision) || b.base_revision<1
    || !b.gen || typeof b.gen.tier!=='string' || typeof b.gen.traits!=='string' || !Array.isArray(b.items)
    || !(b.relation_first_seen_at===null || Number.isSafeInteger(b.relation_first_seen_at))) fail('invalid_bundle');
  validatePublicationItems(b.items);
}
function loadBundle(dir:string, expectedSha?:string) {
  const bytes=regularBytes(join(dir,'bundle.json')), digest=sha256(bytes);
  if(expectedSha!==undefined && expectedSha!==digest) fail('bundle_sha_mismatch');
  const bundle=JSON.parse(bytes.toString('utf8')) as Bundle;
  validateBundleShape(bundle);
  const clips=bundle.items.map(item=>{
    const audio=regularBytes(join(dir,'audio',`${item.id}.${item.format}`));
    validateClipBytes(item,audio); return {item,audio};
  });
  return {bundle,digest,clips};
}
function argsOf(argv:string[]) {
  const [mode='inspect',...rest]=argv;
  if(!['inspect','prepare','verify','publish','recover'].includes(mode)||rest.length%2) fail('invalid_arguments');
  const opts:Record<string,string>={};
  const allowed = mode === 'inspect' ? ['--device-suffix'] : mode === 'prepare' ? ['--device-suffix','--output']
    : mode === 'verify' ? ['--bundle'] : ['--bundle','--expect-revision','--expect-bundle-sha'];
  for(let i=0;i<rest.length;i+=2) {
    if(!allowed.includes(rest[i]) || opts[rest[i]] || !rest[i+1] || rest[i+1].startsWith('--')) fail('invalid_arguments');
    opts[rest[i]]=rest[i+1];
  }
  return {mode,opts};
}
async function main() {
  const {mode,opts}=argsOf(process.argv.slice(2));
  if(mode==='inspect'||mode==='prepare') {
    const devices=readDb(devicesPath), profile=readDb(profilePath);
    try {
      devices.exec('BEGIN');profile.exec('BEGIN');
      const device=readIdentity(devices,opts['--device-suffix']??'');
      const state=profile.prepare('SELECT * FROM local_audio_state WHERE account_id=?').get(device.account_id);
      if(!state || Number(state.revision)<1) fail('no_published_package');
      const items=profile.prepare('SELECT slot,id,text,sha256,bytes,duration_ms,format,created_at,active FROM local_audio_item WHERE account_id=? AND active=1 ORDER BY slot,created_at').all(device.account_id) as LocalAudioItem[];
      // inspection 从数据库及实际字节核验；坏包可prepare留证，但绝不能publish。
      let error:string|null=null;
      try { validatePublicationItems(items); } catch(e) { error=(e as {code?:string}).code??'invalid_publication'; }
      const clips=items.map(item=>{
        if(!/^[0-9a-f]{16}$/.test(item.id)||!['wav','mp3'].includes(item.format)) fail('invalid_clip_path');
        const audio=regularBytes(join(audioRoot,device.account_id,`${item.id}.${item.format}`));
        try { validateClipBytes(item,audio); } catch(e) { error??=(e as {code?:string}).code??'invalid_clip'; }
        return {item,audio};
      });
      const result:Record<string,unknown>={mode,device_suffix:device.sn.slice(-8),revision:state.revision,clips:items.length,valid:error===null,error,
        slots:Object.fromEntries([...new Set(items.map(i=>i.slot))].map(slot=>[slot,items.filter(i=>i.slot===slot).length]))};
      if(mode==='prepare') {
        if(!opts['--output']) fail('output_required');
        const dir=resolve(opts['--output']);mkdirSync(dir,{mode:0o700});mkdirSync(join(dir,'audio'),{mode:0o700});
        const bundle:Bundle={kind:'p003-local-audio-release-v1',prepared_at:new Date().toISOString(),device,
          relation_first_seen_at:relationAnchor(profile,device.account_id),base_revision:Number(state.revision),
          gen:{tier:String(state.gen_tier),traits:String(state.gen_traits)},items,source_sha256:sourceHashes()};
        for(const {item,audio} of clips)writeFileSync(join(dir,'audio',`${item.id}.${item.format}`),audio,{mode:0o600,flag:'wx'});
        const bytes=JSON.stringify(bundle,null,2)+'\n';writeFileSync(join(dir,'bundle.json'),bytes,{mode:0o600,flag:'wx'});
        result.bundle_sha256=sha256(bytes);
      }
      return result;
    } finally { profile.close();devices.close(); }
  }
  if(!opts['--bundle'])fail('bundle_required');
  const dir=resolve(opts['--bundle']);
  if(mode==='verify') {
    const {bundle,digest}=loadBundle(dir);
    return {mode,valid:true,device_suffix:bundle.device.sn.slice(-8),clips:bundle.items.length,bundle_sha256:digest};
  }
  if(!/^\d+$/.test(opts['--expect-revision']??'')||!/^[0-9a-f]{64}$/.test(opts['--expect-bundle-sha']??''))fail('explicit_authorization_required');
  const expected=Number(opts['--expect-revision']);if(!Number.isSafeInteger(expected)||expected<1)fail('invalid_revision');
  const {bundle,digest,clips}=loadBundle(dir,opts['--expect-bundle-sha']);
  if(process.env.LOCAL_AUDIO_WRITES_PAUSED!=='0')fail('local_audio_writes_paused');
  // 先在只读连接拒绝所有失效授权；只有完成下列检查才加载会创建/迁移表的写store。
  const roDevices=readDb(devicesPath), roProfile=readDb(profilePath);
  const checkIdentity=(db:DatabaseSync)=>{
    const current=readIdentity(db,bundle.device.sn.slice(-8));
    if(JSON.stringify(current)!==JSON.stringify(bundle.device))fail('device_identity_changed');
  };
  const checkRelation=()=>{
    if(relationAnchor(roProfile,bundle.device.account_id)!==bundle.relation_first_seen_at)fail('relation_identity_changed');
  };
  try {
    checkIdentity(roDevices);checkRelation();
    if(Number(roProfile.prepare('SELECT revision FROM local_audio_state WHERE account_id=?').get(bundle.device.account_id)?.revision)!==expected)fail('revision_conflict');
    const devices=new DatabaseSync(devicesPath);devices.exec('PRAGMA busy_timeout=5000');
    try {
      // 设备归属写锁覆盖stage到commit；profile内的关系锚在发布写锁内再核一次，堵换绑/重置竞态。
      devices.exec('BEGIN IMMEDIATE');checkIdentity(devices);checkRelation();
      const {localAudioStore:store}=await import('../src/local-audio-store.js');
      if(store.publicationGuardVersion!==1)fail('unsupported_release_store');
      if(store.getState(bundle.device.account_id).revision!==expected)fail('revision_conflict');
      for(const {item,audio} of clips){store.writeAudio(bundle.device.account_id,item.id,audio,item.format);store.insertItem(bundle.device.account_id,item);}
      const revision=store.commitSet(bundle.device.account_id,bundle.items.map(i=>({slot:i.slot,id:i.id})),bundle.gen,
        {expectedRevision:expected,guard:checkRelation});
      devices.exec('COMMIT');
      return {mode,device_suffix:bundle.device.sn.slice(-8),previous_revision:expected,revision:revision??expected,changed:revision!==null,
        bundle_sha256:digest,clips:bundle.items.length,applied_not_modified:true};
    } catch(e) {if(devices.isTransaction)devices.exec('ROLLBACK');throw e;} finally {devices.close();}
  } finally {roDevices.close();roProfile.close();}
}
try { console.log(JSON.stringify(await main())); }
catch(e) {console.log(JSON.stringify({ok:false,code:(e as {code?:string}).code??'release_failed'}));process.exitCode=1;}
