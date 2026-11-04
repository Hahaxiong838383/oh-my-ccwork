import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createECDH,generateKeyPairSync,randomBytes,sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const tmp=mkdtempSync(join(tmpdir(),'p003-enrollment-boundaries-'));
process.env.DEVICES_DB_PATH=join(tmp,'devices.db');process.env.DEVICE_ENROLLMENT_CONFIG_PATH=join(tmp,'config.json');
const {deviceRegistryStore:registry}=await import('../src/device-registry-store.js');
const {getBleBindingStore}=await import('../src/ble-binding-store.js');getBleBindingStore();
const {DeviceEnrollmentStore}=await import('../src/device-enrollment-store.js');
const {readEnrollmentConfig,parsePublicIdentity,issueIdentityStatement}=await import('../src/device-enrollment-proof.js');
let now=Date.now();const start=now;
const cfg={enabled:true,starts_at_ms:now-1000,expires_at_ms:now+14*86400000,issuer_key_id:'test-issuer',signing_secret:randomBytes(32).toString('base64url'),provisioning_token:randomBytes(32).toString('base64url')};
const store=new DeviceEnrollmentStore(process.env.DEVICES_DB_PATH,()=>now),other=new DeviceEnrollmentStore(process.env.DEVICES_DB_PATH,()=>now);
const db=new DatabaseSync(process.env.DEVICES_DB_PATH);let serial=9100,passed=0;
function fixture(){
 const sn='BJP003261104'+String(++serial).padStart(8,'0');const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const e=createECDH('prime256v1');e.generateKeys();
 const body={sn,model:'P003',device_key_id:'key-'+serial,identity_public_key_spki:keys.publicKey.export({type:'spki',format:'der'}).toString('base64url')};
 const issued=store.issue(body,cfg);
 const input={binding_protocol:'ble-enroll-v1',sn,device_key_id:body.device_key_id,ble_session_id:randomBytes(16).toString('hex'),ble_transcript_hash:randomBytes(32).toString('hex'),pairing_nonce:randomBytes(32).toString('base64url'),credential_pk:e.getPublicKey(null,'compressed').toString('base64url'),identity_public_key_spki:body.identity_public_key_spki,identity_statement:issued.identity_statement};
 const signature=(p:string)=>sign('sha256',Buffer.from(p,'base64url'),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');return{sn,body,input,signature};
}
function rejects(fn:()=>unknown,error:string){assert.throws(fn,(e:any)=>e.error===error);}
function test(name:string,fn:()=>void){now=start;cfg.enabled=true;fn();passed++;console.log('PASS '+name);}
const complete=(f:ReturnType<typeof fixture>,account='parent-A')=>{const c=store.prepare(account,f.input,cfg);return store.confirm(account,c.challenge_id,f.signature(c.signing_payload_b64url),()=>cfg);};
test('two connections cannot claim the same SN for different accounts',()=>{
 const f=fixture();const a=store.prepare('parent-A',f.input,cfg);const b=other.prepare('parent-B',{...f.input,pairing_nonce:randomBytes(32).toString('base64url')},cfg);
 const result=store.confirm('parent-A',a.challenge_id,f.signature(a.signing_payload_b64url),()=>cfg);
 rejects(()=>other.confirm('parent-B',b.challenge_id,f.signature(b.signing_payload_b64url),()=>cfg),'device_already_bound');assert.equal(registry.get(f.sn)?.parent_account_id,'parent-A');
 assert.equal(store.confirm('parent-A',a.challenge_id,f.signature(a.signing_payload_b64url),()=>cfg).binding_id,result.binding_id);
});
test('challenge exact expiry rejects without registry or key creation',()=>{const f=fixture();const c=store.prepare('parent-A',f.input,cfg);now+=120000;rejects(()=>store.confirm('parent-A',c.challenge_id,f.signature(c.signing_payload_b64url),()=>cfg),'challenge_expired');assert.equal(registry.get(f.sn),null);});
test('closing gate between prepare and confirm creates no device',()=>{const f=fixture();const c=store.prepare('parent-A',f.input,cfg);cfg.enabled=false;rejects(()=>store.confirm('parent-A',c.challenge_id,f.signature(c.signing_payload_b64url),()=>cfg),'enrollment_closed');assert.equal(registry.get(f.sn),null);});
test('revoking identity statement before confirm rejects',()=>{const f=fixture();const c=store.prepare('parent-A',f.input,cfg);db.prepare('UPDATE device_identity_statement SET revoked_at_ms=? WHERE sn=?').run(now,f.sn);rejects(()=>store.confirm('parent-A',c.challenge_id,f.signature(c.signing_payload_b64url),()=>cfg),'device_identity_invalid');assert.equal(registry.get(f.sn),null);});
test('changing registry state during challenge rejects',()=>{const f=fixture();const c=store.prepare('parent-A',f.input,cfg);registry.add(f.sn,'other admission');rejects(()=>store.confirm('parent-A',c.challenge_id,f.signature(c.signing_payload_b64url),()=>cfg),'binding_changed');assert.equal(registry.get(f.sn)?.parent_account_id,null);});
test('failed database write rolls back registry, tombstone, key and binding',()=>{
 const f=fixture();const c=store.prepare('parent-A',f.input,cfg);
 db.exec("CREATE TEMP TABLE ignored(x INTEGER)");
 db.exec(`CREATE TRIGGER test_atomic_failure BEFORE INSERT ON device_identity_key WHEN NEW.sn='${f.sn}' BEGIN SELECT RAISE(ABORT,'test rollback'); END;`);
 assert.throws(()=>store.confirm('parent-A',c.challenge_id,f.signature(c.signing_payload_b64url),()=>cfg));
 assert.equal(registry.get(f.sn),null);assert.equal(db.prepare('SELECT 1 FROM device_binding_state WHERE sn=?').get(f.sn),undefined);assert.equal(db.prepare('SELECT 1 FROM ble_binding_receipt WHERE sn=?').get(f.sn),undefined);
 db.exec('DROP TRIGGER test_atomic_failure');assert.equal(store.confirm('parent-A',c.challenge_id,f.signature(c.signing_payload_b64url),()=>cfg).account_id,'parent-A');
});
test('disabled device remains disabled',()=>{const f=fixture();registry.add(f.sn,'disabled');registry.setStatus(f.sn,'disabled');rejects(()=>store.prepare('parent-A',f.input,cfg),'device_not_available');assert.equal(registry.get(f.sn)?.status,'disabled');});
test('legacy deletion tombstone cannot be bypassed',()=>{const f=fixture();registry.add(f.sn,'deleted');registry.remove(f.sn);rejects(()=>store.prepare('parent-A',f.input,cfg),'device_not_available');});
test('same public key cannot be issued for another SN',()=>{const f=fixture();rejects(()=>store.issue({...f.body,sn:'BJP00326110400009999'},cfg),'identity_key_conflict');});
test('signed but unissued statement is not accepted',()=>{const f=fixture();const identity=parsePublicIdentity(f.body);const forged=issueIdentityStatement(identity,cfg,now);rejects(()=>store.prepare('parent-A',{...f.input,identity_statement:forged.statement},cfg),'device_identity_invalid');});
test('tampered public key does not match signed statement',()=>{const f=fixture(),g=fixture();rejects(()=>store.prepare('parent-A',{...f.input,identity_public_key_spki:g.input.identity_public_key_spki},cfg),'device_identity_invalid');});
test('committed receipt survives window and certificate expiry but not owner transfer',()=>{const f=fixture();const c=store.prepare('parent-A',f.input,cfg);const sig=f.signature(c.signing_payload_b64url);const b=store.confirm('parent-A',c.challenge_id,sig,()=>cfg);now+=400*86400000;assert.equal(store.confirm('parent-A',c.challenge_id,sig,()=>{throw new Error('config must not be consulted');}).binding_id,b.binding_id);registry.setParentAccountId(f.sn,'parent-B');rejects(()=>store.confirm('parent-A',c.challenge_id,sig,()=>cfg),'binding_not_found');});
test('another challenge cannot reuse consumed nonce',()=>{const f=fixture();complete(f);rejects(()=>store.prepare('parent-A',f.input,cfg),'binding_changed');});
test('signature from another purpose or key cannot enroll',()=>{const f=fixture(),g=fixture();const c=store.prepare('parent-A',f.input,cfg);rejects(()=>store.confirm('parent-A',c.challenge_id,g.signature(c.signing_payload_b64url),()=>cfg),'device_proof_invalid');rejects(()=>store.confirm('parent-A',c.challenge_id,f.signature(Buffer.from('P003-BLE-BIND-V1').toString('base64url')),()=>cfg),'device_proof_invalid');assert.equal(registry.get(f.sn),null);});
test('pending capacity has a finite per-account bound',()=>{const f=fixture();for(let n=0;n<12;n++)store.prepare('limit-account',f.input,cfg);rejects(()=>store.prepare('limit-account',f.input,cfg),'rate_limited');now+=120000;assert.ok(store.prepare('limit-account',f.input,cfg).challenge_id);});
test('public-key and statement parsing reject extras, wrong model and noncanonical data',()=>{const f=fixture();rejects(()=>store.issue({...f.body,extra:true},cfg),'bad_request');rejects(()=>store.issue({...f.body,model:'other'},cfg),'bad_request');rejects(()=>store.issue({...f.body,identity_public_key_spki:f.body.identity_public_key_spki+'='},cfg),'bad_request');rejects(()=>store.prepare('parent-A',{...f.input,extra:true},cfg),'bad_request');});
test('config permissions and separated credentials are enforced',()=>{writeFileSync(process.env.DEVICE_ENROLLMENT_CONFIG_PATH!,JSON.stringify(cfg),{mode:0o600});assert.equal(readEnrollmentConfig().issuer_key_id,cfg.issuer_key_id);chmodSync(process.env.DEVICE_ENROLLMENT_CONFIG_PATH!,0o644);rejects(()=>readEnrollmentConfig(),'enrollment_unavailable');chmodSync(process.env.DEVICE_ENROLLMENT_CONFIG_PATH!,0o600);writeFileSync(process.env.DEVICE_ENROLLMENT_CONFIG_PATH!,JSON.stringify({...cfg,provisioning_token:cfg.signing_secret}));rejects(()=>readEnrollmentConfig(),'enrollment_unavailable');});
db.close();console.log(`Enrollment boundaries ${passed}/${passed} PASS`);
