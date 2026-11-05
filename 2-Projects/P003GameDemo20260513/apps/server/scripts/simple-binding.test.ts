/** Isolated HTTP routing + real SQLite + SMS verify + ECIES. No production data or outbound providers. */
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createECDH,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const tmp=mkdtempSync(join(tmpdir(),'p003-simple-binding-'));
process.chdir(tmp);
for(const n of ['DEVICES','ACCOUNTS','PROFILE','PAIRING','CONFIG','SMS','TELEMETRY']) process.env[n+'_DB_PATH']=join(tmp,n+'.db');
Object.assign(process.env,{AUTH_JWT_SECRET:randomBytes(32).toString('hex'),LOCAL_AUDIO_GENERATION_PAUSED:'1',PAIRING_CLAIM_RPM_SN:'1000',PAIRING_CLAIM_RPM_IP:'1000',DEVICE_SESSION_RPM:'1000',PAIRING_RECOVERY_CONTRACT_ENABLED:'0'});
const {Hono}=await import('hono');
const {profileRoute}=await import('../src/routes/profile.js');
const {parentPairingRoute,devicePairingRoute}=await import('../src/routes/pairing.js');
const {deviceSessionRoute}=await import('../src/routes/device-session.js');
const {smsAuthRoute}=await import('../src/routes/sms-auth.js');
const {verifyCodeStore}=await import('../src/verify-code-store.js');
const {deviceRegistryStore:registry}=await import('../src/device-registry-store.js');
const {decryptCredential}=await import('../src/pairing-crypto.js');
const {verifyDeviceCredential}=await import('../src/device-credential.js');
const {accountStore}=await import('../src/account-store.js');
const {AnalyticsDeviceReader}=await import('../src/analytics/device-context.js');
const analyticsReader=new AnalyticsDeviceReader({devicesPath:process.env.DEVICES_DB_PATH!,configPath:process.env.CONFIG_DB_PATH!,deviceKeySecret:'isolated-only',envAllow:[]});
const {SignJWT}=await import('jose');
const app=new Hono();app.route('/api/profile',profileRoute);app.route('/api/parent/pairing',parentPairingRoute);app.route('/v1/device/pairing',devicePairingRoute);app.route('/v1/device',deviceSessionRoute);app.route('/api/auth',smsAuthRoute);
async function req(path:string,token?:string,body?:unknown){const r=await app.request(path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,json:await r.json() as any};}
let n=0;const pass=(name:string)=>console.log(`PASS ${++n} ${name}`);
const phoneA='13800009131',phoneB='13800009132';
verifyCodeStore.issue(phoneA,'682931');verifyCodeStore.issue(phoneB,'593812');
const la=await req('/api/auth/sms/verify',undefined,{phone:phoneA,code:'682931'}),lb=await req('/api/auth/sms/verify',undefined,{phone:phoneB,code:'593812'});
assert.equal(la.status,200);assert.equal(lb.status,200);const a=la.json.token,b=lb.json.token;
const sn='BJP00326110500009131',sn2='BJP00326110500009132';
assert.equal((await req('/api/profile/bind-sn',undefined,{sn})).status,401);
assert.equal((await req('/api/profile/bind-sn',a,{sn,phone:phoneB})).status,400);
const bound=await req('/api/profile/bind-sn',a,{sn});assert.equal(bound.status,200);assert.equal(bound.json.already_bound,false);assert.equal(bound.json.brain_state,'ready');assert.ok(bound.json.public_id);assert.equal(registry.get(sn)?.parent_account_id,la.json.account.id);assert.equal(registry.get(sn)?.binding_policy,'legacy');
assert.equal((await req('/api/profile/bind-sn',a,{sn})).json.already_bound,true);assert.equal((await req('/api/profile/bind-sn',b,{sn})).status,409);
pass('SMS identity; unknown SN created without statement; owner/idempotency and body phone rejected');
const key=createECDH('prime256v1');key.generateKeys();let nonce=randomBytes(32).toString('base64url');
const confirmBody=()=>({sn,nonce,pk:key.getPublicKey(null,'compressed').toString('base64url'),pairing_protocol:2});
const confirm=await req('/api/parent/pairing/confirm',a,confirmBody());assert.equal(confirm.status,200);const sid=confirm.json.session_id;
assert.equal((await req('/api/parent/pairing/confirm',a,confirmBody())).json.session_id,sid);
assert.equal((await req('/api/parent/pairing/confirm',b,confirmBody())).status,409);
const poll=()=>req('/api/parent/pairing/status?session_id='+sid,a);
assert.equal((await poll()).json.state,'pending');
const claimBody=()=>({sn,pairing_nonce:nonce,pairing_protocol:2});
const claimed=await req('/v1/device/pairing/claim',undefined,claimBody());assert.equal(claimed.status,200);
const credential=decryptCredential(key.getPrivateKey(),claimed.json.enc,nonce,sn);
assert.equal((await poll()).json.state,'bound');assert.equal((await poll()).json.activated,false);
assert.equal((await req('/api/parent/pairing/status?session_id='+sid,b)).status,404);
assert.equal((await req('/v1/device/session/prefetch','invalid',{})).status,401);assert.equal((await poll()).json.activated,false);
assert.equal((await req('/v1/device/session/prefetch',credential,{})).status,200);assert.equal((await poll()).json.state,'activated');assert.equal((await poll()).json.activated,true);
assert.equal((await req('/v1/device/pairing/claim',undefined,claimBody())).status,200);
pass('confirm retry fixed; actual encrypted claim; only successful device authentication activates current session');
const db=new DatabaseSync(process.env.DEVICES_DB_PATH!);const accounts=new DatabaseSync(process.env.ACCOUNTS_DB_PATH!);
assert.ok(await verifyDeviceCredential('Bearer '+credential,process.env.AUTH_JWT_SECRET!,analyticsReader.acceptsCredential.bind(analyticsReader),analyticsReader.readCredentialState.bind(analyticsReader)));
registry.setParentAccountId(sn,lb.json.account.id);
assert.equal((await req('/v1/device/pairing/claim',undefined,claimBody())).status,409);assert.equal((await poll()).status,409);
assert.equal(await verifyDeviceCredential('Bearer '+credential,process.env.AUTH_JWT_SECRET!),null);
assert.equal(await verifyDeviceCredential('Bearer '+credential,process.env.AUTH_JWT_SECRET!,analyticsReader.acceptsCredential.bind(analyticsReader),analyticsReader.readCredentialState.bind(analyticsReader)),null);
registry.setParentAccountId(sn,la.json.account.id);
assert.equal((await req('/v1/device/pairing/claim',undefined,claimBody())).status,409); // owner changed away and back
pass('first/repeated claim and old credentials reject changed ownership/generation even when old recovery flag is off');
// Version changes after confirm invalidate the unclaimed session too.
nonce=randomBytes(32).toString('base64url');
assert.equal((await req('/api/parent/pairing/confirm',a,confirmBody())).status,200);
db.prepare('UPDATE device_registry SET binding_version=binding_version+1 WHERE sn=?').run(sn);
assert.equal((await req('/v1/device/pairing/claim',undefined,claimBody())).status,409);
// A distinct new pairing must not be marked active by an older session credential.
nonce=randomBytes(32).toString('base64url');const c2=await req('/api/parent/pairing/confirm',a,confirmBody());const cl2=await req('/v1/device/pairing/claim',undefined,claimBody());assert.equal(cl2.status,200);const cred2=decryptCredential(key.getPrivateKey(),cl2.json.enc,nonce,sn);
nonce=randomBytes(32).toString('base64url');const c3=await req('/api/parent/pairing/confirm',a,confirmBody());assert.equal((await req('/v1/device/pairing/claim',undefined,claimBody())).status,200);
assert.equal((await req('/v1/device/session/prefetch',cred2,{})).status,200);
assert.equal((await req('/api/parent/pairing/status?session_id='+c2.json.session_id,a)).json.activated,true);assert.equal((await req('/api/parent/pairing/status?session_id='+c3.json.session_id,a)).json.activated,false);
pass('activation is persistent and session-specific, never inferred from other credentials');
// Cross-DB initialization failure retains ownership and supports retry.
accounts.exec("CREATE TRIGGER test_fail_brain BEFORE INSERT ON account WHEN NEW.role='device' BEGIN SELECT RAISE(ABORT,'test'); END");
const partial=await req('/api/profile/bind-sn',a,{sn:sn2});assert.equal(partial.status,200);assert.equal(partial.json.brain_state,'initializing');assert.equal(partial.json.brain_opened,false);assert.equal(registry.get(sn2)?.parent_account_id,la.json.account.id);assert.equal((await req('/api/profile/bind-sn',b,{sn:sn2})).status,409);
accounts.exec('DROP TRIGGER test_fail_brain');assert.equal((await req('/api/profile/bind-sn',a,{sn:sn2})).json.brain_state,'ready');
pass('initialization failure is accurate and retryable without losing ownership');
registry.setStatus(sn2,'disabled');assert.equal((await req('/api/profile/bind-sn',a,{sn:sn2})).status,404);assert.equal((await req('/api/parent/pairing/confirm',a,{...confirmBody(),sn:sn2})).status,404);
registry.remove(sn2);assert.equal((await req('/api/profile/bind-sn',a,{sn:sn2})).status,404);assert.equal(registry.get(sn2),null);
pass('disabled and deleted history are not resurrected by auto-registration');
// Signed device-role account JWT cannot create a parent binding.
const roleToken=await new SignJWT({accountId:accountStore.createDeviceAccount('TEST','test').id,role:'device'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
assert.equal((await req('/api/profile/bind-sn',roleToken,{sn:sn2})).status,403);assert.equal((await req('/api/parent/pairing/confirm',roleToken,confirmBody())).status,403);
pass('device-role JWT cannot bind or confirm for parents');
// Existing unversioned legacy credentials remain compatible.
const old=await new SignJWT({kind:'p003-device'}).setSubject(sn).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));assert.ok(await verifyDeviceCredential('Bearer '+old,process.env.AUTH_JWT_SECRET!));
pass('existing unversioned legacy credential compatibility');
console.log(`PASS ${n} groups; private fixtures ${tmp}`);
