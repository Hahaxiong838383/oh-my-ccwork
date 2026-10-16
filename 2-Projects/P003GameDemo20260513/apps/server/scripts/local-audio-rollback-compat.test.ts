import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const safetyRoot = process.env.LOCAL_AUDIO_SAFETY_SERVER_ROOT;
assert.ok(safetyRoot, 'set LOCAL_AUDIO_SAFETY_SERVER_ROOT to the verified safety build');
const temp = mkdtempSync(join(tmpdir(), 'la-sr-compat-'));
for (const key of ['PROFILE','DEVICES','CONFIG','CONVERSATION','ACCOUNTS','FEEDBACK','DIAGNOSTICS','OTA','PAIRING','SMS','TELEMETRY']) process.env[`${key}_DB_PATH`] = join(temp, `${key}.db`);
process.env.LOCAL_AUDIO_DIR = join(temp, 'audio');
process.env.LOCAL_AUDIO_WRITES_PAUSED = '0';
process.env.AUTH_JWT_SECRET = 's-r-isolated-test-only';
const sn = 'BJP00326060100009971', account = `device-${sn}`;
process.env.DEVICE_SN_ALLOW = sn;
process.env.PERSONA_LOCAL_AUDIO_ENABLED = '1';
process.env.PERSONA_STATE_ACCOUNT_ALLOWLIST = '';
const {localAudioStore: store, REQUIRED_SLOTS} = await import('../src/local-audio-store.js');
const {pcmToWav} = await import('../src/providers/xfyun-tts.js');
const audio = pcmToWav(Buffer.alloc(48000));
const gen = {tier:'新朋友', traits:'{}'};
const items = REQUIRED_SLOTS.flatMap(slot=>[0,1].map(n=>store.stageClipImmutable(account,{slot,text:`短句${n}`,audio,format:'wav',durationMs:1000})));
assert.ok(items.every(i=>i.id!==i.sha256.slice(0,16)));
store.commitSet(account,items,gen,{expectedRevision:0});
writeFileSync(join(temp,'fixture.json'),JSON.stringify({account,sn,manifest:store.buildManifest(account),gen}));
// 子进程真正加载S源码，不用R模块缓存冒充回滚验证。
const script = `
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const f=JSON.parse(readFileSync(process.env.LA_FIXTURE,'utf8'));
const root=process.env.LOCAL_AUDIO_SAFETY_SERVER_ROOT;
const {localAudioStore:s}=await import(pathToFileURL(root+'/src/local-audio-store.ts'));
assert.equal(s.stageClipImmutable,undefined,'must load safety, not repair build');
assert.equal(s.publicationGuardVersion,1);
assert.deepEqual(s.buildManifest(f.account),f.manifest);
assert.equal(s.commitSet(f.account,s.listActive(f.account),f.gen,{expectedRevision:1}),null);
assert.throws(()=>s.commitSet(f.account,s.listActive(f.account),f.gen,{expectedRevision:1,guard:()=>{throw Error('anchor changed')}}),/anchor changed/);
process.env.LOCAL_AUDIO_WRITES_PAUSED='1';
const {localAudioDeviceRoute:route}=await import(pathToFileURL(root+'/src/routes/local-audio.ts'));
const {SignJWT}=await import(pathToFileURL(root+'/node_modules/jose/dist/webapi/index.js'));
const token=await new SignJWT({kind:'p003-device'}).setSubject(f.sn).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
const headers={authorization:'Bearer '+token};
const manifest=await (await route.request('/manifest',{headers})).json();
assert.deepEqual(manifest.slots,f.manifest.slots);
for(const clip of Object.values(manifest.slots).flat()){
 const response=await route.request('/file/'+clip.id,{headers}); assert.equal(response.status,200);
 assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),clip.sha256);
}
assert.equal(s.getState(f.account).last_applied_revision,0);
console.log('S reads R manifest, serves new IDs, verifies all bytes, preserves revision and applied PASS');
`;
const r=spawnSync(process.execPath,['--experimental-sqlite','--import',resolve(safetyRoot,'node_modules/tsx/dist/loader.mjs'),'--input-type=module','-e',script],
  {encoding:'utf8',cwd:safetyRoot,env:{...process.env,LA_FIXTURE:join(temp,'fixture.json')}});
assert.equal(r.status,0,r.stderr+'\n'+r.stdout);
console.log(r.stdout.trim().split('\n').at(-1));
