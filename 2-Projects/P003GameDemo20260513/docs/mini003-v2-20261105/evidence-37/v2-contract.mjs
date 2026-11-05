// 37 独立v2合同；仅固定源码归档、私有SQLite、合成登录身份；不代表main或Android实测。
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,realpathSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {createHash,createECDH,createPublicKey,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import net from 'node:net';
const [root,output]=process.argv.slice(2);assert.ok(realpathSync(root).includes('/verification-37/run-'));
const tmp=mkdtempSync(join(dirname(output),'db-'));
for(const k of Object.keys(process.env))if(k!=='PATH'&&k!=='TZ')delete process.env[k];
for(const k of ['DEVICES','ACCOUNTS','PROFILE','PAIRING','CONFIG','TELEMETRY','SMS','CONVERSATION','FEEDBACK','DIAGNOSTICS','OTA','ARK'])process.env[k+'_DB_PATH']=join(tmp,k+'.db');
Object.assign(process.env,{AUTH_JWT_SECRET:randomBytes(32).toString('hex'),LOCAL_AUDIO_GENERATION_PAUSED:'1',SMS_PROVIDER:'spug',SEARCH_ENABLED:'0',DEVICE_SN_ALLOW:'',DEVICE_ENROLLMENT_CONFIG_PATH:join(tmp,'absent-enrollment.json')});process.chdir(tmp);
net.Socket.prototype.connect=function(){throw new Error('audit_outbound_forbidden');};globalThis.fetch=async()=>{throw new Error('audit_outbound_forbidden');};
const print=console.log.bind(console);console.log=console.warn=console.error=()=>{};
const reqmod=createRequire(join(root,'package.json')),imp=p=>import(pathToFileURL(join(root,'src',p)).href);
const miniReq=createRequire('/Users/fu-121/.codex/worktrees/p003-miniapp-joint-20261029/2-Projects/P003GameDemo20260513/apps/miniapp/package.json');
const noblePath=miniReq.resolve('@noble/curves/nist.js');const {p256}=await import(pathToFileURL(noblePath).href);
const {Hono}=await import(pathToFileURL(reqmod.resolve('hono')).href);
const {SignJWT,decodeJwt}=await import(pathToFileURL(reqmod.resolve('jose')).href);
const {BleBindingStore}=await imp('ble-binding-store.ts');
const {smsAuthRoute}=await imp('routes/sms-auth.ts'),{verifyCodeStore}=await imp('verify-code-store.ts');
const {deviceEnrollmentRoute}=await imp('routes/device-enrollments.ts');
const {bleBindingsRoute}=await imp('routes/ble-bindings.ts'),{devicePairingRoute}=await imp('routes/pairing.ts'),{deviceSessionRoute}=await imp('routes/device-session.ts');
const {getDeviceEnrollmentStore,DeviceEnrollmentStore}=await imp('device-enrollment-store.ts');getDeviceEnrollmentStore();
const {verifyDeviceProof}=await imp('ble-binding-proof.ts'),{decryptCredential}=await imp('pairing-crypto.ts');
const {deviceRegistryStore:registry}=await imp('device-registry-store.ts');
const db=new DatabaseSync(process.env.DEVICES_DB_PATH);
const app=new Hono();app.route('/api/auth',smsAuthRoute);app.route('/api/parent/device-enrollments',deviceEnrollmentRoute);app.route('/api/parent/ble-bindings',bleBindingsRoute);app.route('/v1/device/pairing',devicePairingRoute);app.route('/v1/device',deviceSessionRoute);
const requests=[],tests=[];let A,B,aid,bid,serial=9400;
const digest=b=>createHash('sha256').update(b).digest('hex');
async function request(path,t,body){const r=await app.request(path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(t?{authorization:'Bearer '+t}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});let j;try{j=await r.json();}catch{j={};}requests.push({path,status:r.status,error:j.error??j.code??null,request_id:j.request_id??r.headers.get('x-request-id')??null});return{status:r.status,j};}
async function test(id,fn){if(process.argv[4]&&id!=='LOGIN'&&!process.argv[4].split(',').includes(id))return;try{await fn();tests.push({id,status:'pass'});}catch(e){tests.push({id,status:'fail',reason:String(e.message).split('\n')[0]});}}
function identity(sn=`BJP0032611050000${++serial}`){const privateKey=p256.utils.randomSecretKey(),raw=p256.getPublicKey(privateKey,false);const pub=createPublicKey({key:{kty:'EC',crv:'P-256',x:Buffer.from(raw.slice(1,33)).toString('base64url'),y:Buffer.from(raw.slice(33)).toString('base64url')},format:'jwk'});const der=pub.export({type:'spki',format:'der'});return{sn,privateKey,der,pem:pub.export({type:'spki',format:'pem'}),fp:digest(der),keyId:'p003_'+digest(der).slice(0,48)};}
function session(id){const recipient=createECDH('prime256v1');recipient.generateKeys();return{id,recipient,input:{binding_protocol:'ble-enroll-v2',sn:id.sn,device_key_id:id.keyId,ble_session_id:randomBytes(16).toString('hex'),ble_transcript_hash:randomBytes(32).toString('hex'),pairing_nonce:randomBytes(32).toString('base64url'),credential_pk:recipient.getPublicKey(null,'compressed').toString('base64url'),identity_public_key_spki:id.der.toString('base64url')}};}
const signBytes=(id,bytes)=>Buffer.from(p256.sign(bytes,id.privateKey,{prehash:true,format:'compact'})).toString('base64url');
const challenge=(s,t=A)=>request('/api/parent/device-enrollments/challenge',t,s.input);
async function prepare(s,t=A){const r=await challenge(s,t);assert.equal(r.status,200,'v2 challenge accepted without statement/config');return r.j;}
function lines(s,c,account=aid){const row=db.prepare('SELECT expires_at_ms FROM device_enrollment_challenge WHERE challenge_id=?').get(c.challenge_id);const received=Buffer.from(c.signing_payload_b64url,'base64url').toString('ascii').split('\n');assert.match(received[3],/^[A-Za-z0-9_-]{43}$/,'server nonce32');return['P003-BLE-ENROLL-V2','kidshub-ai.hahaxiong.cc',c.challenge_id,received[3],account,s.id.sn,s.id.keyId,s.id.fp,s.input.ble_session_id,s.input.ble_transcript_hash,s.input.credential_pk,s.input.pairing_nonce,String(row.expires_at_ms)];}
const confirm=(s,c,t=A,sig)=>request('/api/parent/device-enrollments/confirm',t,{challenge_id:c.challenge_id,device_signature:sig??signBytes(s.id,Buffer.from(c.signing_payload_b64url,'base64url'))});
const poll=(id,t=A)=>request('/api/parent/ble-bindings/'+id,t);
const claim=s=>request('/v1/device/pairing/claim',undefined,{binding_protocol:'ble-key-v1',sn:s.id.sn,pairing_nonce:s.input.pairing_nonce});
const prefetch=t=>request('/v1/device/session/prefetch',t,{});
async function enroll(s){const c=await prepare(s),r=await confirm(s,c);assert.equal(r.status,200,'v2 confirmation accepted');return{c,r};}
await test('LOGIN',async()=>{
const result=[];for(const phone of ['13800009401','13800009402']){verifyCodeStore.issue(phone,'583172');const r=await request('/api/auth/sms/verify',undefined,{phone,code:'583172'});assert.equal(r.status,200,'actual SMS verify route');result.push(r.j);}A=result[0].token;B=result[1].token;aid=result[0].account.id;bid=result[1].account.id;assert.notEqual(aid,bid);});
if(!A||!B)throw new Error('login prerequisite failed');
await test('V03-independent-pure-JS-signature-oracle',async()=>{
 const id=identity(),s=session(id);const vector=['P003-BLE-ENROLL-V2','kidshub-ai.hahaxiong.cc','audit37_challenge',randomBytes(32).toString('base64url'),aid,id.sn,id.keyId,id.fp,s.input.ble_session_id,s.input.ble_transcript_hash,s.input.credential_pk,s.input.pairing_nonce,String(Date.now()+120000)].join('\n');
 const bytes=Buffer.from(vector,'ascii'),sig=signBytes(id,bytes);assert.equal(Buffer.from(sig,'base64url').length,64);assert.ok(verifyDeviceProof(id.pem,bytes.toString('base64url'),sig),'noble signs -> server OpenSSL verifies');
 assert.equal(verifyDeviceProof(id.pem,Buffer.from(vector+'\n').toString('base64url'),sig),false,'trailing LF changes proof');assert.equal(verifyDeviceProof(id.pem,bytes.toString('base64url'),signBytes(id,createHash('sha256').update(bytes).digest())),false,'double hash rejected');
 writeFileSync(join(dirname(output),'public-signature-vector.json'),JSON.stringify({scope:'synthetic public vector; no private key; not Android Keystore',spki_b64url:id.der.toString('base64url'),payload_b64url:bytes.toString('base64url'),payload_sha256:digest(bytes),signature_p1363_b64url:sig},null,2)+'\n',{mode:0o600});
});
await test('V01-no-config-capabilities-and-auth',async()=>{assert.equal((await request('/api/parent/device-enrollments/capabilities')).status,401);const r=await request('/api/parent/device-enrollments/capabilities',A);assert.equal(r.status,200,'v2 capabilities independent of old config');assert.ok(JSON.stringify(r.j).includes('ble-enroll-v2'),'capabilities advertises v2');});
await test('V03-V04-exact13-and-wrong-signed-bytes',async()=>{
 const s=session(identity()),c=await prepare(s),expected=lines(s,c).join('\n'),actual=Buffer.from(c.signing_payload_b64url,'base64url');assert.equal(actual.toString('ascii'),expected,'independent exact13 oracle');assert.equal(c.signature_alg,'ECDSA-P256-SHA256-P1363');assert.equal(c.expires_in_s,120);assert.equal(registry.get(s.id.sn),null,'challenge creates no registry');
 for(const wrong of [expected.replace('P003-BLE-ENROLL-V2','P003-BLE-ENROLL-V1'),expected.replaceAll('\n','\r\n'),expected+'\n',expected.replace(s.id.fp,'ab'.repeat(32))]){assert.equal((await confirm(s,c,A,signBytes(s.id,Buffer.from(wrong)))).status,403,'signed altered payload rejected');}
 assert.equal((await confirm(s,c,B)).status,404,'other account cannot consume challenge');assert.equal(registry.get(s.id.sn),null,'bad proofs create no registry');assert.equal((await confirm(s,c)).status,200,'unaltered independent signature accepted');
});
await test('V05-V07-atomic-bind-claim-idempotence',async()=>{
 const s=session(identity()),{c,r}=await enroll(s),row=registry.get(s.id.sn);assert.equal(row.parent_account_id,aid);assert.equal(row.binding_policy,'ble-key-v1');assert.equal(db.prepare('SELECT count(*) n FROM device_identity_key WHERE sn=?').get(s.id.sn).n,1);
 const again=await confirm(s,c);assert.equal(again.j.binding_id,r.j.binding_id);assert.equal(again.j.binding_version,r.j.binding_version);
 assert.equal((await challenge(session(s.id),B)).status,409,'B cannot steal owner');const cl=await claim(s);assert.equal(cl.status,200);assert.equal(cl.j.binding_protocol,'ble-key-v1');assert.equal((await poll(r.j.binding_id)).j.activation_state,'pending_device_auth');
 const token=decryptCredential(s.recipient.getPrivateKey(),cl.j.enc,s.input.pairing_nonce,s.id.sn);assert.equal((await prefetch(token)).status,200);assert.equal((await poll(r.j.binding_id)).j.activation_state,'activated');assert.equal((await poll(r.j.binding_id,B)).status,404);
});
await test('V08-old-credential-cannot-activate-new-receipt',async()=>{
 const id=identity(),s1=session(id),one=await enroll(s1),cl1=await claim(s1);assert.equal(cl1.status,200);const oldToken=decryptCredential(s1.recipient.getPrivateKey(),cl1.j.enc,s1.input.pairing_nonce,id.sn);assert.equal((await prefetch(oldToken)).status,200);
 const s2=session(id),two=await enroll(s2);assert.notEqual(one.r.j.binding_id,two.r.j.binding_id);const cl2=await claim(s2);assert.equal(cl2.status,200);assert.equal((await poll(two.r.j.binding_id)).j.activation_state,'pending_device_auth');
 // New credential deliberately not decrypted/saved/authenticated until AFTER old-credential probe.
 assert.equal((await prefetch(oldToken)).status,200);assert.equal((await poll(two.r.j.binding_id)).j.activation_state,'pending_device_auth','old token cannot impersonate new receipt');
 const legacyPayload=decodeJwt(oldToken);delete legacyPayload.ble_binding_id;
 const legacyToken=await new SignJWT(legacyPayload).setProtectedHeader({alg:'HS256'}).sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
 assert.equal((await prefetch(legacyToken)).status,200,'historic token without receipt id remains usable');assert.equal((await poll(two.r.j.binding_id)).j.activation_state,'pending_device_auth','historic no-id token must not activate new receipt');
 const newToken=decryptCredential(s2.recipient.getPrivateKey(),cl2.j.enc,s2.input.pairing_nonce,id.sn);assert.equal((await prefetch(newToken)).status,200);assert.equal((await poll(two.r.j.binding_id)).j.activation_state,'activated');
});
await test('V02-key-id-and-field-shape-rejected',async()=>{
 const s=session(identity());for(const input of [{...s.input,device_key_id:'p003_'+'00'.repeat(24)},{...s.input,identity_statement:''},{...s.input,pairing_nonce:'bad'}]){const r=await request('/api/parent/device-enrollments/challenge',A,input);assert.ok([400,409].includes(r.status),'malformed v2 rejected before persistence');}assert.equal(registry.get(s.id.sn),null);
});
await test('V01-closed-expired-config-and-v1-discovery',async()=>{
 const config={enabled:false,starts_at_ms:1,expires_at_ms:2,issuer_key_id:'audit37',signing_secret:randomBytes(32).toString('base64url'),provisioning_token:randomBytes(32).toString('base64url')};
 writeFileSync(process.env.DEVICE_ENROLLMENT_CONFIG_PATH,JSON.stringify(config),{mode:0o600});
 for(const enabled of [false,true]){
  config.enabled=enabled;writeFileSync(process.env.DEVICE_ENROLLMENT_CONFIG_PATH,JSON.stringify(config));
  const v2=await request('/api/parent/device-enrollments/capabilities',A);assert.equal(v2.status,200);assert.equal(v2.j.binding_protocol,'ble-enroll-v2');assert.equal(v2.j.enabled,true);assert.equal(v2.j.identity_statement_required,false);assert.equal(v2.j.window_expires_at_ms,null);
  const v1=await request('/api/parent/device-enrollments/capabilities?binding_protocol=ble-enroll-v1',A);assert.equal(v1.status,200);assert.equal(v1.j.enabled,false);assert.equal(v1.j.binding_protocol,'ble-enroll-v1');
  const s=session(identity()),store=getDeviceEnrollmentStore(),c=store.prepare(aid,s.input);assert.ok(store.confirm(aid,c.challenge_id,signBytes(s.id,Buffer.from(c.signing_payload_b64url,'base64url')),()=>{throw new Error('v2 read old config');}).binding_id);
 }
 assert.equal((await request('/api/parent/device-enrollments/capabilities?binding_protocol=unknown',A)).status,400);
});
await test('V05-transaction-rollback-and-Brain-retry',async()=>{
 const s=session(identity()),store=getDeviceEnrollmentStore(),c=store.prepare(aid,s.input),signature=signBytes(s.id,Buffer.from(c.signing_payload_b64url,'base64url'));
 db.exec(`CREATE TRIGGER audit37_key_failure BEFORE INSERT ON device_identity_key BEGIN SELECT RAISE(ABORT,'isolated fixture'); END`);
 try{assert.throws(()=>store.confirm(aid,c.challenge_id,signature),'key insert failure rolls back');}finally{db.exec('DROP TRIGGER audit37_key_failure');}
 for(const t of ['device_registry','device_identity_key','device_binding_state','ble_binding_receipt'])assert.equal(db.prepare(`SELECT count(*) n FROM ${t} WHERE sn=?`).get(s.id.sn).n,0,'no partial '+t);
 const accounts=new DatabaseSync(process.env.ACCOUNTS_DB_PATH);accounts.exec("CREATE TRIGGER audit37_brain_failure BEFORE INSERT ON account WHEN NEW.role='device' BEGIN SELECT RAISE(ABORT,'isolated fixture'); END");
 let r;try{r=await confirm(s,c);}finally{accounts.exec('DROP TRIGGER audit37_brain_failure');accounts.close();}
 assert.equal(r.status,200);assert.equal(r.j.brain_state,'initializing');assert.equal(registry.get(s.id.sn).parent_account_id,aid);
 const retried=await poll(r.j.binding_id);assert.equal(retried.status,200);assert.equal(retried.j.brain_state,'ready');assert.equal((await confirm(s,c)).j.binding_id,r.j.binding_id);
});
await test('V06-two-process-owner-and-key-race',async()=>{
 const config=join(tmp,'race-env.json');writeFileSync(config,JSON.stringify({...process.env,AUDIT37_CWD:tmp}),{mode:0o600});const workers=[];
 const wait=(w,predicate)=>new Promise((resolve,reject)=>{const end=(error,value)=>{clearTimeout(timer);w.off('message',onMessage);w.off('exit',onExit);error?reject(error):resolve(value);};const onMessage=m=>{if(predicate(m))end(null,m);};const onExit=()=>end(new Error('worker exited'));const timer=setTimeout(()=>end(new Error('worker timeout')),15000);w.on('message',onMessage);w.once('exit',onExit);});
 try{
  for(let i=0;i<2;i++){const w=fork(fileURLToPath(new URL('./v2-race-worker.mjs',import.meta.url)),[root,config],{execArgv:['--experimental-sqlite','--import',join(root,'node_modules/tsx/dist/loader.mjs')],env:{PATH:process.env.PATH},stdio:['ignore','ignore','ignore','ipc']});workers.push(w);await wait(w,m=>m.ready);}
  for(let round=0;round<2;round++){
   const id=identity(),ss=[session(id),session(round?identity(id.sn):id)],store=getDeviceEnrollmentStore(),cs=[store.prepare(aid,ss[0].input),store.prepare(bid,ss[1].input)];
   const pending=workers.map(w=>wait(w,m=>m.id===round));workers.forEach((w,i)=>w.send({id:round,account:i?bid:aid,challenge:cs[i].challenge_id,signature:signBytes(ss[i].id,Buffer.from(cs[i].signing_payload_b64url,'base64url'))}));const result=await Promise.all(pending);
   assert.deepEqual(result.map(r=>r.status).sort(),[200,409],'race statuses='+result.map(r=>r.status).join(','));const winner=result[0].status===200?0:1;
   assert.equal(registry.get(id.sn).parent_account_id,winner?bid:aid);assert.equal(db.prepare('SELECT count(*) n FROM device_identity_key WHERE sn=?').get(id.sn).n,1);assert.equal(db.prepare('SELECT fingerprint FROM device_identity_key WHERE sn=?').get(id.sn).fingerprint,ss[winner].id.fp);
  }
 }finally{for(const w of workers)w.kill();}
});
await test('V09-expiry-generation-tombstone-and-recovery-TTL',async()=>{
 let now=Date.now();const store=new DeviceEnrollmentStore(process.env.DEVICES_DB_PATH,()=>now),noConfig=()=>{throw new Error('v2 old config');};
 const expired=session(identity()),ec=store.prepare(aid,expired.input);now=ec.expires_at_ms;assert.throws(()=>store.confirm(aid,ec.challenge_id,signBytes(expired.id,Buffer.from(ec.signing_payload_b64url,'base64url')),noConfig),e=>e.error==='challenge_expired');assert.equal(registry.get(expired.id.sn),null);
 now=Date.now();const s=session(identity()),c=store.prepare(aid,s.input),signed=signBytes(s.id,Buffer.from(c.signing_payload_b64url,'base64url')),b=store.confirm(aid,c.challenge_id,signed,noConfig);
 const receipt=db.prepare('SELECT * FROM ble_binding_receipt WHERE binding_id=?').get(b.binding_id);assert.equal(receipt.claim_expires_at_ms-receipt.bound_at_ms,600000);
 const cl=await claim(s);assert.equal(cl.status,200);const token=decryptCredential(s.recipient.getPrivateKey(),cl.j.enc,s.input.pairing_nonce,s.id.sn);
 registry.setParentAccountId(s.id.sn,bid);assert.equal((await prefetch(token)).status,401);assert.equal((await claim(s)).status,409);assert.throws(()=>store.confirm(aid,c.challenge_id,signed,noConfig));
 // Deterministic clock tests keep the real short claim windows unchanged.
 const timed=session(identity()),tc=store.prepare(aid,timed.input),tb=store.confirm(aid,tc.challenge_id,signBytes(timed.id,Buffer.from(tc.signing_payload_b64url,'base64url')),noConfig);
 const ttlRow=db.prepare('SELECT * FROM ble_binding_receipt WHERE binding_id=?').get(tb.binding_id),ble=new BleBindingStore(process.env.DEVICES_DB_PATH,()=>now);
 now=ttlRow.claim_expires_at_ms;assert.throws(()=>ble.claim(timed.id.sn,timed.input.pairing_nonce,r=>r),e=>e.error==='claim_expired');
 now=ttlRow.bound_at_ms+1;const first=ble.claim(timed.id.sn,timed.input.pairing_nonce,r=>r);assert.equal(first.idempotent,false);const claimedAt=now;
 now=claimedAt+899999;assert.equal(ble.claim(timed.id.sn,timed.input.pairing_nonce,r=>r).idempotent,true);
 now=claimedAt+900000;assert.throws(()=>ble.claim(timed.id.sn,timed.input.pairing_nonce,r=>r),e=>e.error==='claim_expired');now=Date.now();
 const d=session(identity());registry.add(d.id.sn,'fixture');registry.setStatus(d.id.sn,'disabled');assert.throws(()=>store.prepare(aid,d.input),e=>e.error==='device_not_available');
 const t=session(identity());registry.add(t.id.sn,'fixture');registry.remove(t.id.sn);assert.throws(()=>store.prepare(aid,t.input),e=>e.error==='device_not_available');
});
const result={at:new Date().toISOString(),scope:'selected real routes + private SQLite + actual SMS verify fixture; noble JS signs / server OpenSSL verifies; no main/Android/network',noble_source_sha256:digest(readFileSync(noblePath)),tests,requests,pass:tests.filter(t=>t.status==='pass').length,fail:tests.filter(t=>t.status==='fail').length,pending:['V10 old v1/12-line/pairing2 archive regression','V11 exact main and deployment','V12 real phone/device']};writeFileSync(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});print(JSON.stringify({result:output,pass:result.pass,fail:result.fail}));db.close();process.exit(result.fail?1:0);
