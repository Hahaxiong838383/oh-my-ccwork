import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SignJWT } from 'jose';
import { ListeningAuthorityStore } from '../../src/listening-authority-store.js';
import { ListeningSettingsStore } from '../../src/listening-settings-store.js';
import { ListeningAuthority } from '../../src/listening-authority.js';
import { defaultListeningConfig } from '../../src/listening-settings.js';
import { LISTENING_WORKER_CAPABILITIES } from '../../src/listening-http-contract.js';
export async function testAuthority(){
 const dir=mkdtempSync(join(tmpdir(),'listening-auth-http-'));const file=join(dir,'devices.db');const db=new DatabaseSync(file);
 db.exec(`CREATE TABLE device_registry(sn TEXT PRIMARY KEY,status TEXT,account_id TEXT);CREATE TABLE device_credential_revocation(sn TEXT PRIMARY KEY,not_before_sec INTEGER);`);
 const sn='BJP00326070803800006';db.prepare('INSERT INTO device_registry VALUES(?,?,?)').run(sn,'active','test-account-1');
 const store=new ListeningAuthorityStore(file),settings=new ListeningSettingsStore(join(dir,'config.db'));
 let now=1800000000000;let allowedUntil=now+1800000;
 const {schema_version,revision,...editable}=defaultListeningConfig();settings.save(1,{...editable,enabled:true,allowlist:[sn]},'synthetic-integration');
 const secrets={authSecret:'synthetic-auth-secret-at-least-32-bytes',grantSecret:'synthetic-grant-secret-at-least-32-bytes',serviceKey:'synthetic-service-key',workerAccounts:{'rust-worker':'worker-service'}};
 const manifest={version:1,expires_at_ms:now+3600000,evidence_ref:'synthetic/offline-only',agents:[{agent:'rust-worker',build_sha:'a'.repeat(40),capabilities:[...LISTENING_WORKER_CAPABILITIES]}]};
 const authority=new ListeningAuthority({store,getConfig:()=>settings.read().config,clock:()=>now,secrets:()=>secrets,manifest:()=>manifest,sourceDeadline:()=>allowedUntil,sourceGeneration:()=>0,restrictedSince:(revision,sn,scene)=>settings.restrictedSince(revision,sn,scene)});
 const workerToken=await new SignJWT({role:'device',accountId:'worker-service'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setIssuedAt(now/1000-1).setExpirationTime(now/1000+3600).sign(new TextEncoder().encode(secrets.authSecret));
 const serviceHeaders={'authorization':'Bearer '+secrets.serviceKey,'x-p003-worker-token':workerToken};
 const readyBody={version:1,request_id:'ready-1',agent:'rust-worker',instance_id:'instance-1',build_sha:'a'.repeat(40),registered:true,capabilities:[...LISTENING_WORKER_CAPABILITIES],applied_revision:null,applied_config_sha256:null};
 const offer=await authority.workerReady(serviceHeaders,readyBody);
 const readyAck={...readyBody,request_id:'ready-2',applied_revision:offer.policy_revision,applied_config_sha256:offer.config_sha256};
 await authority.workerReady(serviceHeaders,readyAck);
 const deviceToken=await new SignJWT({kind:'p003-device'}).setProtectedHeader({alg:'HS256'}).setSubject(sn).setIssuedAt(now/1000-1).setExpirationTime(now/1000+1800).sign(new TextEncoder().encode(secrets.authSecret));
 const issueInput={sn,room:`sn-${sn}-1800000000`,session_id:'test-session-1',trace_id:'trace-test-1',agent:'rust-worker',supports:['listening_mode_v1'],source:'normal' as const,expires_at_ms:now+1800000,source_cutoff_ms:now+1800000,credential:'Bearer '+deviceToken};
 const metadata=await authority.issue(issueInput);if(!metadata)throw new Error('metadata_not_issued');
 const headers={...serviceHeaders,'x-p003-listening-grant':metadata.grant};
 const base={version:1,request_id:'lease-1',session:metadata.session,listening_id:'trace-test-1:1',scene:'story',mode_epoch:1};
 return {dir,db,store,settings,authority,sn,secrets,manifest,serviceHeaders,readyBody,readyAck,issueInput,metadata,headers,base,
  now:()=>now,advance:(ms:number)=>{now+=ms;},setSourceUntil:(n:number)=>{allowedUntil=n;},cleanup(){store.close();settings.close();db.close();rmSync(dir,{recursive:true,force:true});}};
}
