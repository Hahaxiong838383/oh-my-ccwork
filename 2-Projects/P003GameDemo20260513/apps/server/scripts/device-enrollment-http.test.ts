/** Isolated real HTTP, SQLite and crypto. No production/device credentials. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { SignJWT } from 'jose';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp=mkdtempSync(join(tmpdir(),'p003-enrollment-http-'));
for(const n of ['DEVICES','ACCOUNTS','PROFILE','PAIRING','CONFIG','MEMORY','TELEMETRY','LOCAL_AUDIO']) process.env[`${n}_DB_PATH`]=join(tmp,n+'.db');
process.env.AUTH_JWT_SECRET=randomBytes(32).toString('hex');
process.env.LOCAL_AUDIO_GENERATION_PAUSED='1';
process.env.DEVICE_ENROLLMENT_CONFIG_PATH=join(tmp,'enrollment.json');
process.chdir(tmp);
const config={enabled:true,starts_at_ms:Date.now()-1000,expires_at_ms:Date.now()+86400000,issuer_key_id:'test-issuer',signing_secret:randomBytes(32).toString('base64url'),provisioning_token:randomBytes(32).toString('base64url')};
const saveConfig=()=>writeFileSync(process.env.DEVICE_ENROLLMENT_CONFIG_PATH!,JSON.stringify(config),{mode:0o600});saveConfig();
const {accountStore}=await import('../src/account-store.js');
const {deviceRegistryStore}=await import('../src/device-registry-store.js');
const {getBleBindingStore}=await import('../src/ble-binding-store.js');getBleBindingStore();
const {bleBindingsRoute}=await import('../src/routes/ble-bindings.js');
const {devicePairingRoute}=await import('../src/routes/pairing.js');
const {deviceSessionRoute,verifyDeviceCredential}=await import('../src/routes/device-session.js');
const {decryptCredential}=await import('../src/pairing-crypto.js');
const A=accountStore.upsertPhoneAccount('13800009001'),B=accountStore.upsertPhoneAccount('13800009002');
const token=async(id:string)=>new SignJWT({accountId:id,role:'parent'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET!));
const a=await token(A.id),b=await token(B.id);
const app=new Hono();
app.route('/api/parent/ble-bindings',bleBindingsRoute);app.route('/v1/device/pairing',devicePairingRoute);app.route('/v1/device',deviceSessionRoute);
const routeUrl=new URL('../src/routes/device-enrollments.ts',import.meta.url);
// The baseline deliberately has no new route: assert real 404 -> expected 401 before implementation.
if(existsSync(routeUrl)){
  const {deviceEnrollmentRoute,deviceProvisioningRoute}=await import(routeUrl.href);
  app.route('/api/parent/device-enrollments',deviceEnrollmentRoute);app.route('/v1/device/provisioning',deviceProvisioningRoute);
}
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',resolve));
const port=(server.address() as any).port;
async function req(path:string,t?:string,body?:unknown){
 const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(t?{authorization:`Bearer ${t}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const raw=await r.text();let json:any;try{json=JSON.parse(raw);}catch{json={};}return{status:r.status,json};
}
const db=new DatabaseSync(process.env.DEVICES_DB_PATH!);
const count=(table:string,sn:string)=>Number((db.prepare(`SELECT count(*) AS n FROM ${table} WHERE sn=?`).get(sn) as any).n);
const newIdentity=(sn:string)=>{const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});return{sn,keys,body:{sn,model:'P003',device_key_id:'key-'+sn.slice(-8),identity_public_key_spki:keys.publicKey.export({type:'spki',format:'der'}).toString('base64url')}};};
const fixture=newIdentity('BJP00326110400009001');
const rec=createECDH('prime256v1');rec.generateKeys();
const nonce=randomBytes(32).toString('base64url');
const signature=(key:any,payload:string)=>sign('sha256',Buffer.from(payload,'base64url'),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
try{
 assert.equal((await req('/v1/device/provisioning/identity',undefined,fixture.body)).status,401,'automated provisioning route must exist and reject anonymous issuance');
 assert.equal((await req('/v1/device/provisioning/identity',a,fixture.body)).status,401,'parent bearer is not a provisioning credential');
 const issued=await req('/v1/device/provisioning/identity',config.provisioning_token,fixture.body);
 assert.equal(issued.status,200);assert.equal(issued.json.ok,true);assert.equal(count('device_registry',fixture.sn),0,'issuance cannot pre-register the business device');
 const issuedAgain=await req('/v1/device/provisioning/identity',config.provisioning_token,fixture.body);assert.equal(issuedAgain.json.identity_statement,issued.json.identity_statement);
 const toolConfig=join(tmp,'trusted-tool.json');writeFileSync(toolConfig,JSON.stringify({base_url:`http://127.0.0.1:${port}/`,provisioning_token:config.provisioning_token}),{mode:0o600});
 const tool=spawn(process.execPath,[fileURLToPath(new URL('./provision-device-identity.mjs',import.meta.url)),'--allow-loopback'],{env:{...process.env,P003_PROVISIONER_CONFIG:toolConfig},stdio:['pipe','pipe','pipe']});
 let toolOut='',toolErr='';tool.stdout.on('data',b=>toolOut+=b);tool.stderr.on('data',b=>toolErr+=b);tool.stdin.end(JSON.stringify(fixture.body));
 const toolExit=await new Promise<number|null>((resolve,reject)=>{tool.once('error',reject);tool.once('close',resolve);});assert.equal(toolExit,0,toolErr);assert.equal(JSON.parse(toolOut).identity_statement,issued.json.identity_statement);assert.equal(toolOut.includes(config.provisioning_token),false);assert.equal(toolErr.includes(config.provisioning_token),false);
 const input={binding_protocol:'ble-enroll-v1',sn:fixture.sn,device_key_id:fixture.body.device_key_id,ble_session_id:randomBytes(16).toString('hex'),ble_transcript_hash:randomBytes(32).toString('hex'),pairing_nonce:nonce,credential_pk:rec.getPublicKey(null,'compressed').toString('base64url'),identity_public_key_spki:fixture.body.identity_public_key_spki,identity_statement:issued.json.identity_statement};
 assert.equal((await req('/api/parent/device-enrollments/challenge',undefined,input)).status,401);
 const tampered={...input,identity_statement:issued.json.identity_statement.slice(0,-2)+'AA'};
 assert.equal((await req('/api/parent/device-enrollments/challenge',a,tampered)).status,403);
 assert.equal((await req('/api/parent/device-enrollments/challenge',a,{...input,sn:'BJP00326110400009009'})).status,403);
 const challenge=await req('/api/parent/device-enrollments/challenge',a,input);assert.equal(challenge.status,200);assert.equal(challenge.json.binding_protocol,'ble-enroll-v1');
 assert.equal(count('device_registry',fixture.sn),0,'challenge is not enrollment');assert.equal(count('device_identity_key',fixture.sn),0);
 const payload=Buffer.from(challenge.json.signing_payload_b64url,'base64url').toString();assert.equal(payload.split('\n')[0],'P003-BLE-ENROLL-V1');assert.equal(payload.split('\n').length,14);
 const confirm={challenge_id:challenge.json.challenge_id,device_signature:signature(fixture.keys.privateKey,challenge.json.signing_payload_b64url)};
 assert.equal((await req('/api/parent/device-enrollments/confirm',b,confirm)).status,404);
 assert.equal((await req('/api/parent/device-enrollments/confirm',a,{...confirm,device_signature:randomBytes(64).toString('base64url')})).status,403);assert.equal(count('device_registry',fixture.sn),0);
 const bound=await req('/api/parent/device-enrollments/confirm',a,confirm);assert.equal(bound.status,200);assert.equal(bound.json.binding_state,'bound');assert.equal(bound.json.brain_state,'ready');
 assert.equal(deviceRegistryStore.get(fixture.sn)?.parent_account_id,A.id);assert.equal(count('device_registry',fixture.sn),1);assert.equal(count('device_identity_key',fixture.sn),1);
 const repeated=await req('/api/parent/device-enrollments/confirm',a,confirm);assert.equal(repeated.json.binding_id,bound.json.binding_id);assert.equal(repeated.json.binding_version,bound.json.binding_version);
 assert.equal((await req('/api/parent/device-enrollments/challenge',b,{...input,pairing_nonce:randomBytes(32).toString('base64url')})).status,409);
 const claim=await req('/v1/device/pairing/claim',undefined,{binding_protocol:'ble-key-v1',sn:fixture.sn,pairing_nonce:nonce});assert.equal(claim.status,200);
 const cred=decryptCredential(rec.getPrivateKey(),claim.json.enc,nonce,fixture.sn);assert.equal((await verifyDeviceCredential('Bearer '+cred,process.env.AUTH_JWT_SECRET!))?.sn,fixture.sn);
 assert.equal((await req('/v1/device/session/prefetch',cred,{})).status,200);
 assert.equal((await req('/api/parent/ble-bindings/'+bound.json.binding_id,a)).json.activation_state,'activated');
 assert.equal((await req('/api/parent/ble-bindings/'+bound.json.binding_id,b)).status,404);
 config.enabled=false;saveConfig();
 assert.equal((await req('/api/parent/device-enrollments/confirm',a,confirm)).json.binding_id,bound.json.binding_id,'gate closure cannot break committed receipt retries');
 assert.equal((await req('/api/parent/device-enrollments/challenge',a,input)).status,503);
 assert.equal((await req('/v1/device/pairing/claim',undefined,{binding_protocol:'ble-key-v1',sn:fixture.sn,pairing_nonce:nonce})).status,200,'gate closure cannot stop existing claim');
 config.enabled=true;saveConfig();
 const replaced=newIdentity(fixture.sn);assert.equal((await req('/v1/device/provisioning/identity',config.provisioning_token,replaced.body)).status,409);
 deviceRegistryStore.remove(fixture.sn);
 assert.equal((await req('/api/parent/device-enrollments/challenge',a,{...input,pairing_nonce:randomBytes(32).toString('base64url')})).status,404,'deleted device cannot be silently resurrected');
 console.log('PASS automatic enrollment real HTTP: authenticated issuance/no pre-registration/PoP/atomic binding/idempotency/claim/activation/owner isolation/gate closure/tombstone');
}finally{db.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
