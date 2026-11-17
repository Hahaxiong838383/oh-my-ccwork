/** SQLite/Hono regressions: stale confirmations cannot clear or recreate a later owner. */
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createECDH,randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const tmp=mkdtempSync(join(tmpdir(),'miniapp-unbind-'));
for(const n of ['PAIRING','DEVICES','PROFILE','ACCOUNTS','CONVERSATION','CONFIG','TELEMETRY','FEEDBACK','DIAGNOSTICS'])process.env[`${n}_DB_PATH`]=join(tmp,`${n}.db`);
// Existing pre-migration rows must remain null-version rather than acquire current ownership.
const legacy=new DatabaseSync(process.env.PAIRING_DB_PATH!);
legacy.exec(`CREATE TABLE device_preauth(sn TEXT PRIMARY KEY,parent_account_id TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',until_at INTEGER NOT NULL,created_by TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,used_at INTEGER);
INSERT INTO device_preauth VALUES('legacy-fixture','old-owner','',9999999999999,'fixture',1,NULL);`);legacy.close();
process.chdir(tmp);
process.env.AUTH_JWT_SECRET='unbind-test-secret-32-bytes-long-01';process.env.STUDIO_USER='unbind-admin';process.env.STUDIO_PASS='unbind-pass';
process.env.PAIRING_CLAIM_RPM_SN='1000';process.env.PAIRING_CLAIM_RPM_IP='10000';
// This isolated ownership test must not depend on the host's production disk reserve.
process.env.ARK_RECORDS_MIN_FREE_BYTES='1';
const {Hono}=await import('hono');const {SignJWT}=await import('jose');
const {adminDataRoute}=await import('../src/routes/admin-data.js');const {authRoute}=await import('../src/routes/auth.js');
const {devicePairingRoute,parentPairingRoute,tryAutoConfirm}=await import('../src/routes/pairing.js');
const {profileRoute,performSnBinding}=await import('../src/routes/profile.js');
const {deviceRegistryStore:registry}=await import('../src/device-registry-store.js');
const {pairingStore:pairing,hashToken}=await import('../src/pairing-store.js');
const {accountStore}=await import('../src/account-store.js');const {conversationStore}=await import('../src/conversation-store.js');
const {profileStore}=await import('../src/profile-store.js');const {parentConversationsRoute}=await import('../src/parent-conversations.js');
const {ArkStore}=await import('../src/ark/store.js');
const {RecordsStore}=await import('../src/ark/records-store.js');
const {RecordSchema}=await import('../src/ark/records-contract.js');
await import('../src/telemetry-store.js');
const {getBleBindingStore}=await import('../src/ble-binding-store.js');
const {bleBindingsRoute}=await import('../src/routes/ble-bindings.js');
const app=new Hono();app.route('/api/auth',authRoute);app.route('/api/admin',adminDataRoute);
app.route('/v1/device/pairing',devicePairingRoute);app.route('/api/parent/pairing',parentPairingRoute);
app.route('/api/parent/ble-bindings',bleBindingsRoute);app.route('/api/profile',profileRoute);app.route('/api/devices',parentConversationsRoute);
const {serve}=await import('@hono/node-server');
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});await new Promise<void>(r=>server.listening?r():server.once('listening',r));server.unref();
const base=`http://127.0.0.1:${(server.address() as any).port}`;
let passed=0,failed=0;
function eq(name:string,got:unknown,want:unknown){if(JSON.stringify(got)===JSON.stringify(want))passed++;else{failed++;console.error(`FAIL ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);}}
async function req(path:string,method='GET',body?:unknown,token?:string){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json() as any};}
eq('migration leaves historical preauth version null',pairing.getPreauth('legacy-fixture')?.binding_version,null);
const reopened=new (pairing.constructor as any)();eq('repeat migration preserves historical row',reopened.getPreauth('legacy-fixture')?.binding_version,null);
const admin=(await req('/api/auth/login','POST',{username:'unbind-admin',password:'unbind-pass'})).body.token;
const owner=accountStore.upsertPhoneAccount('13800000101').id,other=accountStore.upsertPhoneAccount('13800000102').id;
const jwt=await new SignJWT({accountId:owner,role:'parent'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode('unbind-test-secret-32-bytes-long-01'));
let serial=100;
function device(bound=true){const sn=`BJP003260601${String(serial++).padStart(8,'0')}`;registry.add(sn,'fixture');if(bound)registry.setParentAccountId(sn,owner);return registry.get(sn)!;}
function expected(d:ReturnType<typeof device>){return{parent_account_id:null,expected_public_id:d.public_id,expected_parent_account_id:d.parent_account_id,expected_binding_version:d.binding_version};}
function unbind(d:ReturnType<typeof device>,patch={}){return req(`/api/admin/devices/${d.sn}/parent`,'PATCH',{...expected(d),...patch},admin);}
function key(){const k=createECDH('prime256v1');k.generateKeys();return k.getPublicKey(undefined,'compressed').toString('base64url');}
const nonce=()=>randomBytes(24).toString('base64url');
const claim=(sn:string,n:string)=>req('/v1/device/pairing/claim','POST',{sn,pairing_protocol:2,pairing_nonce:n,v:3});
const raw=new DatabaseSync(process.env.PAIRING_DB_PATH!),authority=new DatabaseSync(process.env.DEVICES_DB_PATH!);
function restore(table:string,row:Record<string,any>){const cols=Object.keys(row);raw.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>row[c]));}
{
 const d=device(),before=registry.get(d.sn);await req('/api/admin/devices','GET',undefined,admin);eq('open confirmation data then cancel causes no write',registry.get(d.sn),before);
 eq('admin required',(await req(`/api/admin/devices/${d.sn}/parent`,'PATCH',expected(d))).status,401);
 eq('missing CAS rejected',(await req(`/api/admin/devices/${d.sn}/parent`,'PATCH',{parent_account_id:null},admin)).status,400);
 eq('missing CAS preserves owner',registry.get(d.sn)?.parent_account_id,owner);
 for(const patch of [{expected_binding_version:-1},{expected_binding_version:1.5},{expected_binding_version:'1'},{expected_public_id:''},{expected_parent_account_id:''},{note:'x'.repeat(201)}])eq('invalid CAS/note rejected',(await unbind(d,patch)).status,400);
}
{const d=device();registry.setParentAccountId(d.sn,other);eq('stale confirmation 409',(await unbind(d)).status,409);eq('new owner retained',registry.get(d.sn)?.parent_account_id,other);}
{const d=device();registry.setParentAccountId(d.sn,other);registry.setParentAccountId(d.sn,owner);eq('ABA 409',(await unbind(d)).status,409);eq('wrong public id 409',(await unbind(registry.get(d.sn)!,{expected_public_id:'dev_0000000000000000'})).status,409);}
{const d=device(),r=await Promise.all([unbind(d),unbind(d)]);eq('concurrent exactly one success',r.map(x=>x.status).sort(),[200,409]);eq('single generation advance',registry.get(d.sn)?.binding_version,d.binding_version+1);eq('success exposes version',r.find(x=>x.status===200)?.body.binding_version,d.binding_version+1);eq('replay rejected',(await unbind(d)).status,409);}
{
 const d=device();authority.prepare('UPDATE device_registry SET parent_account_id=NULL,binding_version=binding_version+1 WHERE sn=?').run(d.sn);
 const r=performSnBinding(owner,d.sn,false,{parentAccountId:owner,bindingVersion:d.binding_version} as any);
 eq('final binding transaction CAS',r.ok,false);eq('CAS cannot resurrect owner',registry.get(d.sn)?.parent_account_id,null);
}
{
 const d=device();await req(`/api/admin/devices/${d.sn}/preauth`,'PUT',{phone:'13800000101'},admin);const old=pairing.getPreauth(d.sn)!;
 eq('preauth creation version',(old as any).binding_version,d.binding_version);eq('preauth creation owner',(old as any).binding_parent_account_id,owner);
 await unbind(d);eq('unbind releases preauth',pairing.getPreauth(d.sn),null);restore('device_preauth',old as any);
 const n=nonce();eq('copied old preauth cannot confirm',tryAutoConfirm(d.sn,hashToken(n),key(),'announce').done,false);eq('no stale preauth claim',(await claim(d.sn,n)).status,404);eq('preauth cannot resurrect owner',registry.get(d.sn)?.parent_account_id,null);
 {raw.prepare('UPDATE device_preauth SET binding_version=NULL WHERE sn=?').run(d.sn);eq('historical null preauth invalid',tryAutoConfirm(d.sn,hashToken(nonce()),key(),'announce').done,false);}
}
// Auto-confirm can race cleanup across databases; only its original snapshot may reach claim.
{
 const d=device();await req(`/api/admin/devices/${d.sn}/preauth`,'PUT',{phone:'13800000101'},admin);
 const n=nonce(),original=pairing.confirmSessionByHash.bind(pairing);
 pairing.confirmSessionByHash=((...args:any[])=>{
  authority.prepare('UPDATE device_registry SET parent_account_id=NULL,binding_version=binding_version+1 WHERE sn=?').run(d.sn);
  return(original as any)(...args);
 }) as any;
 try{eq('cross-db auto confirm creates original intent',tryAutoConfirm(d.sn,hashToken(n),key(),'announce').done,true);}finally{pairing.confirmSessionByHash=original;}
 eq('racing auto-confirm claim rejects generation',(await claim(d.sn,n)).status,409);
 eq('racing auto-confirm leaves owner empty',registry.get(d.sn)?.parent_account_id,null);
}
{
 const d=device(),n=nonce();eq('parent confirm works',(await req('/api/parent/pairing/confirm','POST',{sn:d.sn,pairing_protocol:2,nonce:n,pk:key()},jwt)).status,200);const session=pairing.findSessionByNonce(n)!;
 await unbind(d);eq('unbind releases sessions',pairing.findUnclaimedSessionBySn(d.sn),null);restore('pairing_session',session as any);
 eq('confirmed before unbind claim denied',(await claim(d.sn,n)).status,409);
 raw.prepare('UPDATE pairing_session SET binding_version=NULL WHERE sn=?').run(d.sn);eq('historical null session denied',(await claim(d.sn,n)).status,409);
 eq('historical session cannot reconfirm',(await req('/api/parent/pairing/confirm','POST',{sn:d.sn,pairing_protocol:2,nonce:n,pk:session.device_pk},jwt)).status,409);eq('stale session cannot resurrect owner',registry.get(d.sn)?.parent_account_id,null);
}
{
 const d=device(),n=nonce();await req('/api/parent/pairing/confirm','POST',{sn:d.sn,pairing_protocol:2,nonce:n,pk:key()},jwt);
 const original=registry.bindParent.bind(registry);registry.bindParent=((...args:any[])=>{authority.prepare('UPDATE device_registry SET parent_account_id=NULL,binding_version=binding_version+1 WHERE sn=?').run(d.sn);return(original as any)(...args);}) as any;
 try{eq('claim final CAS detects concurrent unbind',(await claim(d.sn,n)).status,409);}finally{registry.bindParent=original;}
 eq('claim race owner empty',registry.get(d.sn)?.parent_account_id,null);
}
// An ABA after the registry transaction must not stamp this old claim with the latest generation.
{
 const d=device(false),n=nonce();await req('/api/parent/pairing/confirm','POST',{sn:d.sn,pairing_protocol:2,nonce:n,pk:key()},jwt);
 const original=registry.setAccountId.bind(registry);registry.setAccountId=((sn:string,id:string|null)=>{
  const r=original(sn,id);authority.prepare('UPDATE device_registry SET parent_account_id=NULL,binding_version=binding_version+1 WHERE sn=?').run(sn);
  authority.prepare('UPDATE device_registry SET parent_account_id=?,binding_version=binding_version+1 WHERE sn=?').run(owner,sn);return r;
 }) as any;
 try{eq('post-bind ABA cannot mint latest-generation credential',(await claim(d.sn,n)).status,409);}finally{registry.setAccountId=original;}
 eq('post-bind ABA claim remains unclaimed',pairing.findSessionByNonce(n)?.claimed_at,null);
}
{
 const d=device(false),n=nonce();await req(`/api/admin/devices/${d.sn}/preauth`,'PUT',{phone:'13800000101'},admin);
 eq('positive announce',(await req('/v1/device/pairing/announce','POST',{sn:d.sn,pairing_protocol:2,nonce:n,pk:key(),v:3})).status,200);eq('positive preauth claim',(await claim(d.sn,n)).status,200);
 const current=registry.get(d.sn)!;eq('brain exists',Boolean(current.account_id),true);profileStore.upsertProfile(current.account_id!,{nickname:'fixture-child',birthday:'',gender:''});
 const message=conversationStore.add({account_id:current.account_id,session_id:'keep',role:'user',text:'fixture-only'}),epoch=registry.arkIdentity(d.sn)!;
 const ark=new ArkStore(join(tmp,'ark.db'));ark.authorize(epoch,0);const grant=ark.grant(epoch)!;
 const records=new RecordsStore({arkPath:join(tmp,'ark.db'),devicesPath:process.env.DEVICES_DB_PATH!,allowed:sn=>sn===d.sn,validAccount:id=>accountStore.findAccount(id)?.role==='device',secret:()=>process.env.AUTH_JWT_SECRET!});
 const record=RecordSchema.parse({record_id:'keep-record',save_id:'keep-save',sequence:1,origin_grant_id:grant.grant_id,origin_epoch:grant.epoch,occurred_at_ms:Date.now()-1,time_quality:'reported',logical_day:'2026-11-17',source_mode:'normal',reason:'reward_claim',business_source_id:'fixture-reward',tank_id:null,stage_id:null,resource_changes:[{resource_id:'family_coin',delta:2,before:0,after:2}],item_changes:[]});
 const credential={sn:d.sn,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600,bindingVersion:current.binding_version};
 eq('raw record fixture accepted',records.accept(credential,records.preflight(credential,[record]),record),'accepted');
 const storedRecord=records.db.prepare('SELECT * FROM ark_record WHERE sn=?').get(d.sn);
 const telemetry=new DatabaseSync(process.env.TELEMETRY_DB_PATH!);
 telemetry.prepare('INSERT INTO device_telemetry_snapshot(sn,snapshot_id,captured_at_ms,payload_json,schema_version,device_ts_ms,server_received_ms,clock_skew_ms,ingest_trace_id) VALUES(?,?,?,?,?,?,?,?,?)').run(d.sn,'keep-snapshot',1,'{}',1,1,1,0,'fixture');
 const storedTelemetry=telemetry.prepare('SELECT * FROM device_telemetry_snapshot WHERE sn=?').get(d.sn);
 process.env.PARENT_CONVERSATION_SCOPE_JSON=JSON.stringify({public_id:current.public_id,sn:d.sn,parent_account_id:owner,account_id:current.account_id,binding_version:current.binding_version,epoch:epoch.epoch});
 eq('history before unbind',(await req(`/api/devices/${current.public_id}/conversations`,'GET',undefined,jwt)).status,200);
 eq('positive unbind',(await unbind(current,{note:'fixture'})).status,200);
 eq('brain/public id retained',{account:registry.get(d.sn)?.account_id,id:registry.get(d.sn)?.public_id},{account:current.account_id,id:current.public_id});
 eq('profile retained',profileStore.getProfile(current.account_id!)?.nickname,'fixture-child');eq('conversation retained',conversationStore.list({accountId:current.account_id!}).some(x=>x.id===message.id),true);
 eq('old parent history denied',(await req(`/api/devices/${current.public_id}/conversations`,'GET',undefined,jwt)).status,404);eq('old Ark grant denied',ark.grant(registry.arkIdentity(d.sn)!),null);
 eq('raw business record retained',records.db.prepare('SELECT * FROM ark_record WHERE sn=?').get(d.sn),storedRecord);
 eq('raw telemetry retained',telemetry.prepare('SELECT * FROM device_telemetry_snapshot WHERE sn=?').get(d.sn),storedTelemetry);
 eq('raw Ark grant retained',ark.db.prepare('SELECT grant_id FROM ark_grant WHERE sn=?').get(d.sn)?.grant_id,grant.grant_id);
 registry.setParentAccountId(d.sn,owner);eq('same-owner rebind history stays denied',(await req(`/api/devices/${current.public_id}/conversations`,'GET',undefined,jwt)).status,404);eq('same-owner rebind Ark stays denied',ark.grant(registry.arkIdentity(d.sn)!),null);records.close();telemetry.close();ark.close();
}
{
 const d=device(false),n=nonce();await req('/v1/device/pairing/announce','POST',{sn:d.sn,pairing_protocol:2,nonce:n,pk:key(),v:3});
 eq('manual confirm',(await req(`/api/admin/devices/${d.sn}/pairing/confirm`,'POST',{parent_account_id:owner},admin)).status,200);eq('manual immediate binding',registry.get(d.sn)?.parent_account_id,owner);eq('manual matching claim',(await claim(d.sn,n)).status,200);
}
// Actual BLE proof, cloud confirm and credential claim remain functional and respect admin unbind.
{
 const d=device(false),identity=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 getBleBindingStore().registerIdentityKey({sn:d.sn,keyId:'fixture-key',publicKeyPem:identity.publicKey.export({type:'spki',format:'pem'}).toString(),enablePolicy:true});
 eq('BLE policy blocks direct legacy binding',performSnBinding(owner,d.sn).ok,false);
 eq('BLE policy blocks old preauth',(await req(`/api/admin/devices/${d.sn}/preauth`,'PUT',{phone:'13800000101'},admin)).status,409);
 const n=randomBytes(32).toString('base64url');
 const challenge=await req('/api/parent/ble-bindings/challenge','POST',{binding_protocol:'ble-key-v1',sn:d.sn,device_key_id:'fixture-key',ble_session_id:'a'.repeat(32),ble_transcript_hash:'b'.repeat(64),pairing_nonce:n,credential_pk:key()},jwt);
 eq('BLE challenge works',challenge.status,200);
 const signature=sign('sha256',Buffer.from(challenge.body.signing_payload_b64url,'base64url'),{key:identity.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 const body={challenge_id:challenge.body.challenge_id,device_signature:signature};
 eq('BLE confirm works',(await req('/api/parent/ble-bindings/confirm','POST',body,jwt)).status,200);
 eq('BLE claim works',(await req('/v1/device/pairing/claim','POST',{binding_protocol:'ble-key-v1',sn:d.sn,pairing_nonce:n})).status,200);
 eq('BLE admin unbind works',(await unbind(registry.get(d.sn)!)).status,200);
 eq('BLE old claim denied',(await req('/v1/device/pairing/claim','POST',{binding_protocol:'ble-key-v1',sn:d.sn,pairing_nonce:n})).status,409);
 eq('BLE old confirm denied',(await req('/api/parent/ble-bindings/confirm','POST',body,jwt)).status,409);
 eq('BLE proof policy retained',registry.get(d.sn)?.binding_policy,'ble-key-v1');
}
raw.close();authority.close();await new Promise<void>(r=>server.close(()=>r()));console.log(`miniapp-unbind: ${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
