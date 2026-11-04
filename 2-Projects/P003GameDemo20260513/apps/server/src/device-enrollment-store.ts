import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { getBleBindingStore, type BleBindingRecord } from './ble-binding-store.js';
import { BLE_SIGNATURE_ALGORITHM, BleBindingError, validBleId, verifyDeviceProof } from './ble-binding-proof.js';
import { ENROLLMENT_PROTOCOL, ENROLLMENT_TTL_MS, assertEnrollmentOpen, digest, enrollmentSigningPayload, issueIdentityStatement, parseEnrollmentInput, parsePublicIdentity, readEnrollmentConfig, type EnrollmentConfig, type EnrollmentInput } from './device-enrollment-proof.js';

type Device={sn:string;status:string;parent_account_id:string|null;public_id:string|null;binding_policy:string;binding_version:number};
type Pending={challenge_id:string;account_id:string;sn:string;input_json:string;public_key_pem:string;fingerprint:string;signing_payload_b64url:string;expected_state:string;created_at_ms:number;expires_at_ms:number;binding_id:string|null};
type Issued={statement_id:string;sn:string;key_id:string;fingerprint:string;identity_statement:string;expires_at_ms:number;revoked_at_ms:number|null;issuer_key_id:string};

/** Separate optional workflow, same devices.db transaction and existing binding receipt format. */
export class DeviceEnrollmentStore{
 private db:DatabaseSync;
 constructor(path=process.env.DEVICES_DB_PATH?.trim()||'./data/devices.db',private now:()=>number=Date.now){
  getBleBindingStore(); // Registry and deployed BLE migrations precede this optional schema.
  this.db=new DatabaseSync(resolve(path));this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  this.db.exec(`
   CREATE TABLE IF NOT EXISTS device_identity_statement (
    statement_id TEXT PRIMARY KEY,sn TEXT NOT NULL,key_id TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE,
    issuer_key_id TEXT NOT NULL,identity_statement TEXT NOT NULL,issued_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,
    revoked_at_ms INTEGER,UNIQUE(sn,key_id)
   );
   CREATE TABLE IF NOT EXISTS device_enrollment_challenge (
    challenge_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,sn TEXT NOT NULL,input_json TEXT NOT NULL,
    public_key_pem TEXT NOT NULL,fingerprint TEXT NOT NULL,signing_payload_b64url TEXT NOT NULL,expected_state TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,expires_at_ms INTEGER NOT NULL,binding_id TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_device_enrollment_pending ON device_enrollment_challenge(binding_id,expires_at_ms);
   CREATE INDEX IF NOT EXISTS idx_device_enrollment_account ON device_enrollment_challenge(account_id,binding_id);
  `);
 }
 private transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 private device(sn:string):Device|null{return this.db.prepare('SELECT sn,status,parent_account_id,public_id,binding_policy,binding_version FROM device_registry WHERE sn=?').get(sn) as Device|undefined??null;}
 private available(sn:string):Device|null{
  const row=this.device(sn);
  if(row&&(row.status!=='active'||!['legacy','ble-key-v1'].includes(row.binding_policy)))throw new BleBindingError(404,'device_not_available');
  if(!row&&(this.db.prepare('SELECT 1 FROM device_binding_state WHERE sn=?').get(sn)||this.db.prepare('SELECT 1 FROM device_credential_revocation WHERE sn=?').get(sn)))throw new BleBindingError(404,'device_not_available');
  return row;
 }
 private identityCompatible(sn:string,keyId:string,fingerprint:string):void{
  const keys=this.db.prepare('SELECT sn,key_id,fingerprint,status FROM device_identity_key WHERE sn=? OR fingerprint=?').all(sn,fingerprint) as {sn:string;key_id:string;fingerprint:string;status:string}[];
  if(keys.some(k=>k.sn!==sn||k.key_id!==keyId||k.fingerprint!==fingerprint||k.status!=='active'))throw new BleBindingError(409,'identity_key_conflict');
 }
 private trusted(value:EnrollmentInput):void{
  const issued=this.db.prepare('SELECT * FROM device_identity_statement WHERE statement_id=?').get(value.claims.jti) as Issued|undefined;
  if(!issued||issued.revoked_at_ms!==null||issued.sn!==value.input.sn||issued.key_id!==value.input.device_key_id||issued.fingerprint!==value.fingerprint||issued.identity_statement!==value.statement||issued.expires_at_ms<=this.now())throw new BleBindingError(403,'device_identity_invalid');
 }
 issue(value:unknown,config:EnrollmentConfig){
  assertEnrollmentOpen(config,this.now());const identity=parsePublicIdentity(value);
  return this.transaction(()=>{
   this.available(identity.sn);this.identityCompatible(identity.sn,identity.device_key_id,identity.fingerprint);
   const rows=this.db.prepare('SELECT * FROM device_identity_statement WHERE sn=? OR fingerprint=?').all(identity.sn,identity.fingerprint) as Issued[];
   if(rows.some(r=>r.sn!==identity.sn||r.key_id!==identity.device_key_id||r.fingerprint!==identity.fingerprint||r.revoked_at_ms!==null))throw new BleBindingError(409,'identity_key_conflict');
   const current=rows[0];
   if(current&&current.expires_at_ms>this.now()&&current.issuer_key_id===config.issuer_key_id)return{identity_statement:current.identity_statement,identity_expires_at_ms:current.expires_at_ms,identity_fingerprint:identity.fingerprint,device_key_id:identity.device_key_id,idempotent:true};
   const signed=issueIdentityStatement(identity,config,this.now());
   if(current)this.db.prepare('DELETE FROM device_identity_statement WHERE statement_id=?').run(current.statement_id);
   this.db.prepare('INSERT INTO device_identity_statement(statement_id,sn,key_id,fingerprint,issuer_key_id,identity_statement,issued_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,?)').run(signed.claims.jti,identity.sn,identity.device_key_id,identity.fingerprint,config.issuer_key_id,signed.statement,signed.claims.iat*1000,signed.claims.exp*1000);
   return{identity_statement:signed.statement,identity_expires_at_ms:signed.claims.exp*1000,identity_fingerprint:identity.fingerprint,device_key_id:identity.device_key_id,idempotent:false};
  });
 }
 prepare(accountId:string,raw:unknown,config:EnrollmentConfig){
  if(!validBleId(accountId))throw new BleBindingError(401,'unauthorized');assertEnrollmentOpen(config,this.now());
  const value=parseEnrollmentInput(raw,config,this.now());
  return this.transaction(()=>{
   this.trusted(value);const d=this.available(value.input.sn);this.identityCompatible(value.input.sn,value.input.device_key_id,value.fingerprint);
   if(d?.parent_account_id&&d.parent_account_id!==accountId)throw new BleBindingError(409,'device_already_bound');
   if(this.db.prepare('SELECT 1 FROM ble_binding_receipt WHERE nonce_hash=?').get(digest(value.input.pairing_nonce)))throw new BleBindingError(409,'binding_changed');
   this.db.prepare('DELETE FROM device_enrollment_challenge WHERE challenge_id IN (SELECT challenge_id FROM device_enrollment_challenge WHERE binding_id IS NULL AND expires_at_ms<=? LIMIT 100)').run(this.now());
   const size=this.db.prepare('SELECT count(*) AS n FROM device_enrollment_challenge WHERE binding_id IS NULL').get() as {n:number};
   const own=this.db.prepare('SELECT count(*) AS n FROM device_enrollment_challenge WHERE binding_id IS NULL AND account_id=?').get(accountId) as {n:number};
   if(size.n>=4096||own.n>=12)throw new BleBindingError(429,'rate_limited');
   const id=randomBytes(18).toString('base64url');const expires=this.now()+ENROLLMENT_TTL_MS;
   const payload=enrollmentSigningPayload(accountId,value,id,randomBytes(32).toString('base64url'),expires);
   this.db.prepare('INSERT INTO device_enrollment_challenge(challenge_id,account_id,sn,input_json,public_key_pem,fingerprint,signing_payload_b64url,expected_state,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,accountId,value.input.sn,JSON.stringify(raw),value.pem,value.fingerprint,payload,JSON.stringify(d),this.now(),expires);
   return{binding_protocol:ENROLLMENT_PROTOCOL,challenge_id:id,expires_in_s:ENROLLMENT_TTL_MS/1000,signature_alg:BLE_SIGNATURE_ALGORITHM,signing_payload_b64url:payload};
  });
 }
 confirm(accountId:string,challengeId:string,signature:string,configReader:()=>EnrollmentConfig=readEnrollmentConfig):BleBindingRecord&{already_bound:boolean}{
  if(!validBleId(accountId))throw new BleBindingError(401,'unauthorized');
  if(!validBleId(challengeId)||typeof signature!=='string'||signature.length>100)throw new BleBindingError(400,'bad_request');
  return this.transaction(()=>{
   const p=this.db.prepare('SELECT * FROM device_enrollment_challenge WHERE challenge_id=? AND account_id=?').get(challengeId,accountId) as Pending|undefined;
   if(!p)throw new BleBindingError(404,'binding_not_found');
   if(!verifyDeviceProof(p.public_key_pem,p.signing_payload_b64url,signature))throw new BleBindingError(403,'device_proof_invalid');
   if(p.binding_id){
    // Committed retry is governed by current owner/key/version, not the enrollment window or expired certificate.
    return{...getBleBindingStore().getBinding(accountId,p.binding_id),already_bound:true};
   }
   const config=configReader();assertEnrollmentOpen(config,this.now());
   if(this.now()>=p.expires_at_ms)throw new BleBindingError(410,'challenge_expired');
   const value=parseEnrollmentInput(JSON.parse(p.input_json),config,this.now());this.trusted(value);
   const old=this.available(p.sn);this.identityCompatible(p.sn,value.input.device_key_id,value.fingerprint);
   if(old?.parent_account_id&&old.parent_account_id!==accountId)throw new BleBindingError(409,'device_already_bound');
   if(JSON.stringify(old)!==p.expected_state)throw new BleBindingError(409,'binding_changed');
   const nonceHash=digest(value.input.pairing_nonce);
   if(this.db.prepare('SELECT 1 FROM ble_binding_receipt WHERE nonce_hash=?').get(nonceHash))throw new BleBindingError(409,'binding_changed');
   const now=this.now();const publicId=old?.public_id||`dev_${randomBytes(8).toString('hex')}`;
   const alreadyBound=old?.parent_account_id===accountId;
   const version=old?old.binding_version+((old.binding_policy!=='ble-key-v1'||!alreadyBound)?1:0):1;
   if(old)this.db.prepare("UPDATE device_registry SET binding_policy='ble-key-v1',binding_version=?,parent_account_id=?,public_id=?,updated_at=? WHERE sn=?").run(version,accountId,publicId,now,p.sn);
   else this.db.prepare("INSERT INTO device_registry(sn,note,status,binding_policy,binding_version,parent_account_id,public_id,created_at,updated_at) VALUES(?,'automatic BLE enrollment','active','ble-key-v1',?,?,?,?,?)").run(p.sn,version,accountId,publicId,now,now);
   const updated=this.device(p.sn);
   if(!updated||updated.status!=='active'||updated.parent_account_id!==accountId||updated.binding_policy!=='ble-key-v1'||updated.binding_version!==version)throw new BleBindingError(409,'binding_changed');
   this.db.prepare("INSERT INTO device_identity_key(sn,key_id,public_key_pem,fingerprint,status,created_at,updated_at) VALUES(?,?,?,?,'active',?,?) ON CONFLICT(sn,key_id) DO NOTHING").run(p.sn,value.input.device_key_id,p.public_key_pem,value.fingerprint,now,now);
   this.db.prepare('UPDATE ble_binding_receipt SET revoked_at_ms=? WHERE sn=? AND revoked_at_ms IS NULL').run(now,p.sn);
   this.db.prepare('UPDATE ble_binding_challenge SET revoked_at_ms=? WHERE sn=? AND revoked_at_ms IS NULL').run(now,p.sn);
   const bindingId=randomBytes(18).toString('base64url');
   this.db.prepare('INSERT INTO ble_binding_challenge(challenge_id,account_id,sn,device_key_id,signing_payload_b64url,nonce_hash,credential_pk,expected_version,expected_owner,created_at_ms,expires_at_ms,consumed_at_ms,binding_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(p.challenge_id,accountId,p.sn,value.input.device_key_id,p.signing_payload_b64url,nonceHash,value.input.credential_pk,version,accountId,p.created_at_ms,p.expires_at_ms,now,bindingId);
   this.db.prepare('INSERT INTO ble_binding_receipt(binding_id,challenge_id,sn,account_id,device_key_id,binding_version,nonce_hash,credential_pk,public_id,bound_at_ms,claim_expires_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(bindingId,p.challenge_id,p.sn,accountId,value.input.device_key_id,version,nonceHash,value.input.credential_pk,publicId,now,now+600_000);
   this.db.prepare('UPDATE device_enrollment_challenge SET binding_id=? WHERE challenge_id=?').run(bindingId,p.challenge_id);
   return{...this.db.prepare('SELECT * FROM ble_binding_receipt WHERE binding_id=?').get(bindingId) as BleBindingRecord,already_bound:alreadyBound};
  });
 }
}
let singleton:DeviceEnrollmentStore|undefined;
export const getDeviceEnrollmentStore=()=>singleton??=new DeviceEnrollmentStore();
