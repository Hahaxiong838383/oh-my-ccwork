/** Complete deployed entry point; synthetic identities; Linux network namespace REQUIRED.
 * Run: unshare --net sh -c 'ip link set lo up; node --experimental-sqlite --import tsx scripts/device-enrollment-main.test.ts'
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
const tmp = mkdtempSync(join(tmpdir(), 'p003-enrollment-main-'));
const env: NodeJS.ProcessEnv = {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: tmp, TZ: 'Asia/Shanghai', PORT: '39091',
  AUTH_JWT_SECRET: randomBytes(32).toString('hex'), LOCAL_AUDIO_GENERATION_PAUSED: '1', SEARCH_ENABLED: '0',
  DEVICE_SN_ALLOW: '', TELEMETRY_SN_ALLOWLIST: '', TELEMETRY_ACCEPTANCE_OVERRIDE: '', SMS_PROVIDER: 'spug'};
for (const n of ['DEVICES','ACCOUNTS','PROFILE','PAIRING','CONFIG','TELEMETRY','SMS','CONVERSATION','FEEDBACK','DIAGNOSTICS','OTA','ARK']) {
  env[`${n}_DB_PATH`] = join(tmp, n + '.db');
}
env.DEVICE_ENROLLMENT_CONFIG_PATH = join(tmp, 'enrollment.json');
const config = {enabled: true, starts_at_ms: Date.now()-1000, expires_at_ms: Date.now()+86400000,
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
  evidence.requests.push({path,status:response.status,request_id:json.request_id??null});
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
async function adapter(body:unknown) {
  const cfg=join(tmp,'station.json');
  writeFileSync(cfg,JSON.stringify({base_url:base+'/',provisioning_token:config.provisioning_token}),{mode:0o600});
  const tool=spawn(process.execPath,[join(root,'scripts/provision-device-identity.mjs'),'--allow-loopback'],
    {cwd:tmp,env:{...env,P003_PROVISIONER_CONFIG:cfg},stdio:['pipe','pipe','pipe']});
  let out='',err=''; tool.stdout.on('data',b=>out+=b);tool.stderr.on('data',b=>err+=b);
  const done=once(tool,'close');tool.stdin.end(JSON.stringify(body));
  const [code]=await done; assert.equal(code,0,'station adapter succeeds');
  assert.ok(!out.includes(config.provisioning_token)&&!err.includes(config.provisioning_token));
  return JSON.parse(out);
}
const signature=(key:any,payload:string)=>sign('sha256',Buffer.from(payload,'base64url'),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
let db:DatabaseSync|undefined,accounts:DatabaseSync|undefined,profiles:DatabaseSync|undefined;
const watchdog=setTimeout(()=>{void stop();},110000);
try {
  // The real verification route creates accounts and JWTs; only the SMS delivery step is fixture setup.
  Object.assign(process.env,env);process.chdir(tmp);
  const {verifyCodeStore}=await import('../src/verify-code-store.js');
  const {decryptCredential}=await import('../src/pairing-crypto.js');
  const phoneA='13800009011',phoneB='13800009012';
  verifyCodeStore.issue(phoneA,'682931');verifyCodeStore.issue(phoneB,'593812');
  await start();
  const loginA=await req('/api/auth/sms/verify',undefined,{phone:phoneA,code:'682931'});
  const loginB=await req('/api/auth/sms/verify',undefined,{phone:phoneB,code:'593812'});
  assert.equal(loginA.status,200);assert.equal(loginB.status,200);assert.equal(loginA.json.is_new,true);
  assert.equal(loginA.json.account.role,'parent');assert.notEqual(loginA.json.account.id,loginB.json.account.id);
  const a=loginA.json.token,b=loginB.json.token;
  assert.equal((await req('/api/auth/sms/verify',undefined,{phone:phoneA,code:'682931'})).status,401);
  pass('real main entry + SMS verify HTTP creates isolated A/B accounts and single-use verification code and reusable parent tokens');
  db=new DatabaseSync(env.DEVICES_DB_PATH!);accounts=new DatabaseSync(env.ACCOUNTS_DB_PATH!);profiles=new DatabaseSync(env.PROFILE_DB_PATH!);
  const sn='BJP00326110500009011',keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const publicIdentity={sn,model:'P003',device_key_id:'p003-main-isolated',identity_public_key_spki:keys.publicKey.export({type:'spki',format:'der'}).toString('base64url')};
  const count=(table:string)=>Number((db!.prepare(`SELECT count(*) AS n FROM ${table} WHERE sn=?`).get(sn) as any).n);
  assert.equal((await req('/v1/device/provisioning/identity',undefined,publicIdentity)).status,401);
  assert.equal((await req('/v1/device/provisioning/identity',a,publicIdentity)).status,401);
  const issued=await adapter(publicIdentity),again=await adapter(publicIdentity);
  assert.equal(issued.identity_statement,again.identity_statement);assert.ok(issued.request_id);
  assert.equal(count('device_registry'),0);assert.equal(count('device_identity_key'),0);
  pass('station stdin/stdout issuance and replay are automatic, authenticated, and do not pre-register');
  const recipient=createECDH('prime256v1');recipient.generateKeys();
  const nonce=randomBytes(32).toString('base64url');
  const input={binding_protocol:'ble-enroll-v1',...publicIdentity,ble_session_id:randomBytes(16).toString('hex'),
    ble_transcript_hash:randomBytes(32).toString('hex'),pairing_nonce:nonce,credential_pk:recipient.getPublicKey(null,'compressed').toString('base64url'),identity_statement:issued.identity_statement};
  delete (input as any).model;
  assert.equal((await req('/api/parent/device-enrollments/capabilities',a)).json.enabled,true);
  assert.equal((await req('/api/parent/device-enrollments/challenge',a,{...input,sn:'BJP00326110500009019'})).status,403);
  const challenge=await req('/api/parent/device-enrollments/challenge',a,input);assert.equal(challenge.status,200);
  const payload=Buffer.from(challenge.json.signing_payload_b64url,'base64url').toString();
  assert.equal(payload.split('\n').length,14);assert.equal(payload.split('\n')[0],'P003-BLE-ENROLL-V1');assert.ok(!payload.endsWith('\n'));
  const lines=payload.split('\n');
  const pending=db.prepare('SELECT expires_at_ms,created_at_ms FROM device_enrollment_challenge WHERE challenge_id=?').get(challenge.json.challenge_id) as any;
  assert.equal(challenge.json.signature_alg,'ECDSA-P256-SHA256-P1363');assert.equal(challenge.json.expires_in_s,120);
  assert.match(lines[3],/^[A-Za-z0-9_-]{43}$/);assert.equal(Buffer.from(lines[3],'base64url').length,32);
  // Separate wall-clock reads may differ by milliseconds during the DB insert.
  assert.ok(pending.expires_at_ms-pending.created_at_ms<=120000 && pending.expires_at_ms-pending.created_at_ms>=119000);
  assert.deepEqual(lines,['P003-BLE-ENROLL-V1','kidshub-ai.hahaxiong.cc',challenge.json.challenge_id,lines[3],loginA.json.account.id,sn,publicIdentity.device_key_id,
    createHash('sha256').update(Buffer.from(publicIdentity.identity_public_key_spki,'base64url')).digest('hex'),
    createHash('sha256').update(issued.identity_statement,'utf8').digest('hex'),input.ble_session_id,input.ble_transcript_hash,input.credential_pk,nonce,String(pending.expires_at_ms)]);
  assert.equal(count('device_registry'),0);assert.equal(count('device_identity_key'),0);
  const confirm={challenge_id:challenge.json.challenge_id,device_signature:signature(keys.privateKey,challenge.json.signing_payload_b64url)};
  assert.equal((await req('/api/parent/device-enrollments/confirm',b,confirm)).status,404);
  const wrongPurpose=Buffer.from(payload.replace('P003-BLE-ENROLL-V1','P003-BLE-BIND-V1')).toString('base64url');
  assert.equal((await req('/api/parent/device-enrollments/confirm',a,{...confirm,device_signature:signature(keys.privateKey,wrongPurpose)})).status,403);
  assert.equal(count('device_registry'),0);
  pass('14-line proof rejects wrong device, account and purpose without partial registration');
  // Real cross-DB failure, only in the isolated DB: binding remains committed and Brain can retry.
  accounts.exec(`CREATE TRIGGER test_brain_failure BEFORE INSERT ON account WHEN NEW.role='device' BEGIN SELECT RAISE(ABORT,'isolated fault'); END`);
  const bound=await req('/api/parent/device-enrollments/confirm',a,confirm);assert.equal(bound.status,200);
  assert.equal(bound.json.binding_state,'bound');assert.equal(bound.json.brain_state,'initializing');
  const row=db.prepare('SELECT * FROM device_registry WHERE sn=?').get(sn) as any;
  assert.equal(row.status,'active');assert.equal(row.parent_account_id,loginA.json.account.id);assert.equal(row.binding_policy,'ble-key-v1');
  assert.equal(count('device_identity_key'),1);assert.equal(row.public_id,bound.json.device.public_id);
  accounts.exec('DROP TRIGGER test_brain_failure');
  const receiptPath='/api/parent/ble-bindings/'+bound.json.binding_id;
  assert.equal((await req(receiptPath,a)).json.brain_state,'ready');
  assert.equal((accounts.prepare('SELECT role FROM account WHERE id=?').get('device-'+sn) as any).role,'device');
  assert.ok(profiles.prepare('SELECT 1 FROM family_member WHERE account_id=?').get('device-'+sn));
  const repeat=await req('/api/parent/device-enrollments/confirm',a,confirm);
  assert.equal(repeat.json.binding_id,bound.json.binding_id);assert.equal(repeat.json.binding_version,bound.json.binding_version);
  assert.equal((await req('/api/parent/device-enrollments/challenge',b,{...input,pairing_nonce:randomBytes(32).toString('base64url')})).status,409);
  pass('atomic device binding + separate idempotent Brain initialization recovers from real SQLite failure');
  const claimBody={binding_protocol:'ble-key-v1',sn,pairing_nonce:nonce};
  const claimed=await req('/v1/device/pairing/claim',undefined,claimBody);assert.equal(claimed.status,200);
  assert.equal((await req(receiptPath,a)).json.activation_state,'pending_device_auth');
  const wrongRecipient=createECDH('prime256v1');wrongRecipient.generateKeys();
  assert.throws(()=>decryptCredential(wrongRecipient.getPrivateKey(),claimed.json.enc,nonce,sn));
  const credential=decryptCredential(recipient.getPrivateKey(),claimed.json.enc,nonce,sn);
  assert.equal((await req('/v1/device/session/prefetch',credential,{})).json.status,'warming');
  assert.equal((await req(receiptPath,a)).json.activation_state,'activated');
  assert.equal((await req('/v1/device/config',credential)).status,200);
  pass('encrypted claim only decrypts for recipient; actual device authentication activates and reads default config');
  const mine=await req('/api/profile/bound-devices',a),other=await req('/api/profile/bound-devices',b);
  assert.equal(mine.json.devices.filter((d:any)=>d.public_id===row.public_id).length,1);assert.equal(other.json.devices.length,0);
  const now=Date.now();const batch={schema_version:1,batch_id:'synthetic-main-batch',device_ts_ms:now,
    snapshot:{snapshot_id:'synthetic-main-snapshot',captured_at_ms:now,lid_open:true,present:true,brightness_level:7,image_distance_m:0.42}};
  assert.equal((await req('/v1/device/telemetry',credential,batch)).status,200);
  const dashboardPath='/v1/parent/devices/'+row.public_id+'/dashboard';
  const dash=await req(dashboardPath,a);assert.equal(dash.status,200);assert.equal(dash.json.data.device.brightness_level,7);
  assert.equal(dash.json.data.device.image_distance_m,0.42);assert.equal(dash.json.data.device.online,true);
  assert.equal((await req(dashboardPath,b)).status,404);assert.equal((await req(receiptPath,b)).status,404);
  pass('device data is persisted and parent A reads exact values; parent B cannot see device or dashboard');
  await stop();await start();
  assert.equal((await req('/v1/device/session/prefetch',credential,{})).status,200);
  assert.equal((await req(receiptPath,a)).json.activation_state,'activated');
  assert.equal((await req(dashboardPath,a)).json.data.device.brightness_level,7);
  assert.equal((await adapter(publicIdentity)).identity_statement,issued.identity_statement);
  assert.equal((await req('/api/parent/device-enrollments/confirm',a,confirm)).json.binding_id,bound.json.binding_id);
  pass('real server restart preserves identity, owner, receipt, telemetry and idempotency');
  config.enabled=false;saveConfig();
  assert.equal((await req('/api/parent/device-enrollments/challenge',a,input)).status,503);
  assert.equal((await req('/api/parent/device-enrollments/confirm',a,confirm)).json.binding_id,bound.json.binding_id);
  // Expire only the synthetic receipt rather than sleeping ten minutes or widening production TTLs.
  db.prepare('UPDATE ble_binding_receipt SET claimed_at_ms=NULL,claim_expires_at_ms=? WHERE binding_id=?').run(Date.now()-1,bound.json.binding_id);
  assert.equal((await req('/v1/device/pairing/claim',undefined,claimBody)).json.error,'claim_expired');
  const recoveryNonce=randomBytes(32).toString('base64url');
  const recoveryInput={binding_protocol:'ble-key-v1',sn,device_key_id:publicIdentity.device_key_id,ble_session_id:randomBytes(16).toString('hex'),ble_transcript_hash:randomBytes(32).toString('hex'),pairing_nonce:recoveryNonce,credential_pk:input.credential_pk};
  const rc=await req('/api/parent/ble-bindings/challenge',a,recoveryInput);assert.equal(rc.status,200);
  assert.equal(Buffer.from(rc.json.signing_payload_b64url,'base64url').toString().split('\n').length,12);
  const rb=await req('/api/parent/ble-bindings/confirm',a,{challenge_id:rc.json.challenge_id,device_signature:signature(keys.privateKey,rc.json.signing_payload_b64url)});assert.equal(rb.status,200);
  assert.equal(rb.json.binding_version,bound.json.binding_version);
  const recovered=await req('/v1/device/pairing/claim',undefined,{...claimBody,pairing_nonce:recoveryNonce});assert.equal(recovered.status,200);
  const nextCred=decryptCredential(recipient.getPrivateKey(),recovered.json.enc,recoveryNonce,sn);
  assert.equal((await req('/v1/device/session/prefetch',nextCred,{})).status,200);
  assert.equal((await req('/api/parent/ble-bindings/'+rb.json.binding_id,a)).json.activation_state,'activated');
  pass('closed enrollment gate preserves committed receipts; expired claim recovers with original owner 12-line proof');
  db.prepare('UPDATE device_registry SET parent_account_id=?,binding_version=binding_version+1 WHERE sn=?').run(loginB.json.account.id,sn);
  assert.equal((await req('/v1/device/session/prefetch',nextCred,{})).status,401);
  assert.equal((await req(dashboardPath,a)).status,404);
  pass('owner/version change invalidates old device credential and old parent access');
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
