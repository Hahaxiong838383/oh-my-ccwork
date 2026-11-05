/** Complete deployed entry point; synthetic identities; Linux network namespace REQUIRED.
 * Run: unshare --net sh -c 'ip link set lo up; node --experimental-sqlite --import tsx scripts/device-enrollment-v2-main.test.ts'
 * No production config/DB/secrets are loaded. SMS delivery and Android/BLE hardware are outside this test.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readlinkSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createECDH, generateKeyPairSync, randomBytes, sign, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

assert.equal(process.platform, 'linux', 'run on Linux in an isolated network namespace');
assert.notEqual(readlinkSync('/proc/self/ns/net'), readlinkSync('/proc/1/ns/net'), 'refuse host network');
const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'p003-v2-main-'));
const env: NodeJS.ProcessEnv = {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: tmp, TZ: 'Asia/Shanghai', PORT: '39091',
  AUTH_JWT_SECRET: randomBytes(32).toString('hex'), LOCAL_AUDIO_GENERATION_PAUSED: '1', SEARCH_ENABLED: '0',
  DEVICE_SN_ALLOW: '', TELEMETRY_SN_ALLOWLIST: '', TELEMETRY_ACCEPTANCE_OVERRIDE: '', SMS_PROVIDER: 'spug'};
for (const n of ['DEVICES','ACCOUNTS','PROFILE','PAIRING','CONFIG','TELEMETRY','SMS','CONVERSATION','FEEDBACK','DIAGNOSTICS','OTA','ARK']) {
  env[`${n}_DB_PATH`] = join(tmp, n + '.db');
}
env.DEVICE_ENROLLMENT_CONFIG_PATH = join(tmp, 'enrollment.json');
const config = {enabled: false, starts_at_ms: Date.now()-1000, expires_at_ms: Date.now()+86400000,
  issuer_key_id: 'isolated-main-test', signing_secret: randomBytes(32).toString('base64url'), provisioning_token: randomBytes(32).toString('base64url')};
const saveConfig = () => writeFileSync(env.DEVICE_ENROLLMENT_CONFIG_PATH!, JSON.stringify(config), {mode:0o600});
saveConfig();
// Only static assets are shared; every DB and the current directory are private.
if (existsSync(join(root,'assets'))) symlinkSync(join(root,'assets'),join(tmp,'assets'));
const tsx = import.meta.resolve('tsx');
let child: ChildProcess | undefined;
let serverLog = '';
const evidence: any = {started_at: new Date().toISOString(), node: process.version, source_index_sha256:
  createHash('sha256').update(readFileSync(join(root,'src/index.ts'))).digest('hex'), network_isolated: true, tests: [], requests: []};
const pass = (name: string) => { evidence.tests.push(name); console.log('PASS ' + name); };
const base = 'http://127.0.0.1:39091';
async function req(path: string, token?: string, body?: unknown) {
  const response = await fetch(base+path, {method:body===undefined?'GET':'POST', redirect:'error', signal:AbortSignal.timeout(8000),
    headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const json: any = await response.json();
  evidence.requests.push({path,status:response.status,request_id:json.request_id??response.headers.get('x-request-id')});
  return {status:response.status,json};
}
async function stop() {
  if (!child || child.exitCode!==null || child.signalCode!==null) return;
  const done=once(child,'exit'); child.kill('SIGTERM');
  const timer=setTimeout(()=>child?.kill('SIGKILL'),2000);
  await done; clearTimeout(timer);
}
async function start() {
  child=spawn(process.execPath,['--experimental-sqlite','--import',tsx,join(root,'src/index.ts')],{cwd:tmp,env,stdio:['ignore','pipe','pipe']});
  child.stdout!.on('data',b=>serverLog+=b); child.stderr!.on('data',b=>serverLog+=b);
  for(let i=0;i<150;i++) {
    if(child.exitCode!==null) throw new Error('main entry exited before health');
    try {if((await req('/health')).status===200)return;} catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('main entry did not become healthy');
}
let db:DatabaseSync|undefined,accounts:DatabaseSync|undefined,profiles:DatabaseSync|undefined;
const watchdog=setTimeout(()=>{void stop();},110000);
try {
  Object.assign(process.env,env);process.chdir(tmp);
  const {verifyCodeStore}=await import('../src/verify-code-store.js');
  const {decryptCredential}=await import('../src/pairing-crypto.js');
  const phoneA='13800009141',phoneB='13800009142';
  verifyCodeStore.issue(phoneA,'682931');verifyCodeStore.issue(phoneB,'593812');
  await start();
  const loginA=await req('/api/auth/sms/verify',undefined,{phone:phoneA,code:'682931'});
  const loginB=await req('/api/auth/sms/verify',undefined,{phone:phoneB,code:'593812'});
  assert.equal(loginA.status,200);assert.equal(loginB.status,200);const a=loginA.json.token,b=loginB.json.token;
  const sn='BJP00326110500009151';
  const cap=await req('/api/parent/device-enrollments/capabilities',a);
  assert.equal(cap.json.binding_protocol,'ble-enroll-v2');assert.equal(cap.json.enabled,true);assert.equal(cap.json.identity_statement_required,false);
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const der=keys.publicKey.export({type:'spki',format:'der'}),fp=createHash('sha256').update(der).digest('hex');
  const recipient=createECDH('prime256v1');recipient.generateKeys();const nonce=randomBytes(32).toString('base64url');
  const input={binding_protocol:'ble-enroll-v2',sn,device_key_id:'p003_'+fp.slice(0,48),identity_public_key_spki:der.toString('base64url'),ble_session_id:randomBytes(16).toString('hex'),ble_transcript_hash:randomBytes(32).toString('hex'),pairing_nonce:nonce,credential_pk:recipient.getPublicKey(null,'compressed').toString('base64url')};
  assert.equal((await req('/api/parent/device-enrollments/challenge',undefined,input)).status,401);
  const challenge=await req('/api/parent/device-enrollments/challenge',a,input);assert.equal(challenge.status,200);
  const bytes=Buffer.from(challenge.json.signing_payload_b64url,'base64url');
  const lines=bytes.toString().split('\n');assert.equal(lines.length,13);assert.equal(lines[0],'P003-BLE-ENROLL-V2');assert.equal(lines[7],fp);
  const confirm={challenge_id:challenge.json.challenge_id,device_signature:sign('sha256',bytes,{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};
  assert.equal((await req('/api/parent/device-enrollments/confirm',b,confirm)).status,404);
  const bound=await req('/api/parent/device-enrollments/confirm',a,confirm);assert.equal(bound.status,200);assert.equal(bound.json.brain_state,'ready');assert.equal(bound.json.enrollment_protocol,'ble-enroll-v2');
  assert.equal((await req('/api/parent/device-enrollments/confirm',a,confirm)).json.binding_id,bound.json.binding_id);
  db=new DatabaseSync(env.DEVICES_DB_PATH!);
  const row=db.prepare('SELECT * FROM device_registry WHERE sn=?').get(sn) as any;
  assert.equal(row.parent_account_id,loginA.json.account.id);assert.equal(row.public_id,bound.json.device.public_id);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM device_identity_statement WHERE sn=?').get(sn) as any).n,0);
  pass('actual main + SMS login + v2 exact proof + automatic SN/key/owner/Brain without statement or legacy window');
  const receiptPath='/api/parent/ble-bindings/'+bound.json.binding_id;
  assert.equal((await req(receiptPath,a)).json.activation_state,'pending_network');
  const claimBody={sn,pairing_nonce:nonce,binding_protocol:'ble-key-v1'};
  const claimed=await req('/v1/device/pairing/claim',undefined,claimBody);assert.equal(claimed.status,200);assert.equal(claimed.json.binding_protocol,'ble-key-v1');
  const credential=decryptCredential(recipient.getPrivateKey(),claimed.json.enc,nonce,sn);
  assert.equal((await req(receiptPath,a)).json.activation_state,'pending_device_auth');
  assert.equal((await req('/v1/device/session/prefetch',credential,{})).status,200);
  assert.equal((await req(receiptPath,a)).json.activation_state,'activated');
  assert.equal((await req('/v1/device/config',credential)).status,200);
  pass('unchanged ble-key-v1 ECIES claim + actual device authentication + receipt-specific activation');
  const mine=await req('/api/profile/bound-devices',a),other=await req('/api/profile/bound-devices',b);
  assert.equal(mine.json.devices.filter((d:any)=>d.public_id===row.public_id).length,1);assert.equal(other.json.devices.length,0);
  const now=Date.now();const batch={schema_version:1,batch_id:'synthetic-simple-batch',device_ts_ms:now,
    snapshot:{snapshot_id:'synthetic-simple-snapshot',captured_at_ms:now,lid_open:true,present:true,brightness_level:7,image_distance_m:0.42}};
  assert.equal((await req('/v1/device/telemetry',credential,batch)).status,200);
  const dashboardPath='/v1/parent/devices/'+row.public_id+'/dashboard';
  const dash=await req(dashboardPath,a);assert.equal(dash.status,200);assert.equal(dash.json.data.device.brightness_level,7);
  assert.equal(dash.json.data.device.image_distance_m,0.42);assert.equal(dash.json.data.device.online,true);
  assert.equal((await req(dashboardPath,b)).status,404);assert.equal((await req(receiptPath,b)).status,404);
  pass('real HTTP telemetry persists; owner reads exact values and second parent cannot access');
  await stop();await start();
  assert.equal((await req('/v1/device/session/prefetch',credential,{})).status,200);
  assert.equal((await req(receiptPath,a)).json.activation_state,'activated');
  assert.equal((await req(dashboardPath,a)).json.data.device.brightness_level,7);
  assert.equal((await req('/v1/device/pairing/claim',undefined,claimBody)).status,200);
  pass('actual server restart preserves ownership, saved credential validity, activation and data');
  db.prepare('UPDATE device_registry SET parent_account_id=? WHERE sn=?').run(loginB.json.account.id,sn);
  assert.equal((await req('/v1/device/pairing/claim',undefined,claimBody)).status,409);
  assert.equal((await req('/v1/device/session/prefetch',credential,{})).status,401);
  assert.equal((await req(receiptPath,a)).status,404);assert.equal((await req(dashboardPath,a)).status,404);
  pass('ownership change invalidates retry claim, versioned credential and prior parent access');
  evidence.status='PASS';
} catch(error) {
  evidence.status='FAIL'; evidence.error=error instanceof Error?error.message:String(error);throw error;
} finally {
  clearTimeout(watchdog);await stop();db?.close();accounts?.close();profiles?.close();
  evidence.finished_at=new Date().toISOString();evidence.assertion_groups=evidence.tests.length;
  // These logs contain only synthetic accounts/identities; keep even failed attempts for review.
  writeFileSync(join(tmp,'server.log'),serverLog,{mode:0o600});writeFileSync(join(tmp,'result.json'),JSON.stringify(evidence,null,2),{mode:0o600});
  console.log(JSON.stringify({status:evidence.status,assertion_groups:evidence.tests.length,evidence:join(tmp,'result.json')}));
}
