import {readArkIdentity} from '../ark/identity.js';
import { createHmac } from 'node:crypto';
import { dirname,join,isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {UPLOAD_POLICY_KEY,parseUploadPolicy} from './upload-policy.js';
import type {DeviceCredentialState} from '../device-credential.js';
import {diagnosticRequests,type DiagnosticRequest} from './tier-settings.js';
export type AnalyticsDeviceContext = { deviceKey: string; active: boolean; uploadEnabled: boolean; uploadHourCst: number;subject?:string;diagnosticRequests?:DiagnosticRequest[] };
export class AnalyticsDependencyUnavailable extends Error { constructor(){super('ANALYTICS_DEPENDENCY_UNAVAILABLE');} }
export class AnalyticsDeviceReader {
  constructor(private options: { devicesPath: string; configPath: string; deviceKeySecret: string; envAllow: readonly string[];arkPath?:string }) {
    for (const p of [options.devicesPath, options.configPath]) if (!isAbsolute(p)) throw new Error('analytics dependency paths must be absolute');
    if(options.arkPath&&!isAbsolute(options.arkPath))throw new Error('ark dependency path must be absolute');
    if (!options.deviceKeySecret) throw new Error('ANALYTICS_DEVICE_KEY_SECRET_REQUIRED');
  }
  private read<T>(path: string, fn: (db: DatabaseSync) => T, busyMs=250): T {
    let db: DatabaseSync | undefined;
    try { db = new DatabaseSync(path, {readOnly:true}); db.exec('PRAGMA busy_timeout='+busyMs+';'); return fn(db); }
    catch { throw new AnalyticsDependencyUnavailable(); }
    finally { db?.close(); }
  }
  acceptsCredential(subject: string, iatSec: number): boolean {
    return this.read(this.options.devicesPath, db => {
      const row = db.prepare('SELECT not_before_sec FROM device_credential_revocation WHERE sn=?').get(subject) as {not_before_sec:number}|undefined;
      return !row || iatSec > row.not_before_sec;
    });
  }
  /** Same read-only dependency as analytics context; never opens the main-service writer. */
  readCredentialState(subject:string):DeviceCredentialState {
    return this.read(this.options.devicesPath,db=>{
      const row=db.prepare(`SELECT d.sn AS current_sn,d.binding_policy,d.binding_version,d.status,d.parent_account_id,
        s.binding_policy AS persisted_policy,s.binding_version AS persisted_version,r.not_before_sec
        FROM (SELECT ? AS sn) q
        LEFT JOIN device_registry d ON d.sn=q.sn
        LEFT JOIN device_binding_state s ON s.sn=q.sn
        LEFT JOIN device_credential_revocation r ON r.sn=q.sn`).get(subject) as {
          current_sn:string|null;binding_policy:string|null;binding_version:number|null;status:'active'|'disabled'|null;
          parent_account_id:string|null;persisted_policy:string|null;persisted_version:number|null;not_before_sec:number|null;
        };
      const persisted=row.persisted_policy!==null&&row.persisted_policy!=='legacy';
      const binding=row.current_sn?{
        binding_policy:row.binding_policy==='legacy'&&persisted?row.persisted_policy!:row.binding_policy!,
        binding_version:persisted?Math.max(row.binding_version!,row.persisted_version!):row.binding_version!,
        status:row.status!,parent_account_id:row.parent_account_id,
      }:persisted?{binding_policy:row.persisted_policy!,binding_version:row.persisted_version!,status:'disabled' as const,parent_account_id:null}:null;
      return {binding,revokedThroughSec:row.not_before_sec};
    });
  }
  uploadPolicy(){return this.read(this.options.configPath,db=>{
    const row=db.prepare('SELECT value FROM runtime_flag WHERE key=?').get(UPLOAD_POLICY_KEY) as {value:string}|undefined;
    return row?parseUploadPolicy(row.value):null;
  });}
  readAnalyticsDeviceContext(subject: string): AnalyticsDeviceContext {
    const active = this.read(this.options.devicesPath, db => {
      const row = db.prepare('SELECT status FROM device_registry WHERE sn=?').get(subject) as {status:string}|undefined;
      return row ? row.status === 'active' : this.options.envAllow.includes(subject);
    });
    const config = this.collectionConfigForScope(subject);
    const requests=this.read(this.options.configPath,db=>{
      // Old configuration databases remain valid before the main-service additive migration.
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='analytics_diagnostic_request'").get())return [];
      return diagnosticRequests(db,subject);
    });
    return {deviceKey:createHmac('sha256',this.options.deviceKeySecret).update('p003-analytics-v1\0'+subject).digest('hex'),subject,diagnosticRequests:requests,active,...config};
  }
  readArkIdentity(subject:string){
    return this.read(this.options.devicesPath,db=>readArkIdentity(db,subject),15);
  }
  readArkAuthorization(subject:string){
    const identity=this.readArkIdentity(subject);if(!identity)return null;
    return this.read(this.options.arkPath??join(dirname(this.options.devicesPath),'ark.db'),db=>{
      const g=db.prepare('SELECT g.account_id,g.epoch,g.not_before_ms FROM ark_grant g JOIN ark_settings s ON s.id=1 AND s.enabled=1 WHERE g.sn=?').get(subject) as {account_id:string;epoch:number;not_before_ms:number}|undefined;
      return g&&g.account_id===identity.account_id&&g.epoch===identity.epoch?{...identity,not_before_ms:g.not_before_ms}:null;
    },15);
  }
  arkDeviceKey(subject:string){return createHmac('sha256',this.options.deviceKeySecret).update('p003-analytics-v1\0'+subject).digest('hex');}
  private collectionConfigForScope(subject?: string): {uploadEnabled:boolean;uploadHourCst:number} {
    return this.read(this.options.configPath, db => {
      let uploadEnabled=false,uploadHourCst=23;
      for(const scope of subject ? ['(global)',subject] : ['(global)']) {
        const rows=db.prepare("SELECT key,value_json FROM device_config WHERE scope=? AND key IN ('analytics.event_upload_enabled','analytics.daily_upload_hour_cst')").all(scope) as {key:string;value_json:string}[];
        for(const row of rows){const value=JSON.parse(row.value_json);if(row.key==='analytics.event_upload_enabled'&&typeof value==='boolean')uploadEnabled=value;if(row.key==='analytics.daily_upload_hour_cst'&&Number.isInteger(value)&&value>=0&&value<=23)uploadHourCst=value;}
      }
      return {uploadEnabled,uploadHourCst};
    });
  }
  readGlobalCollectionConfig(): {event_upload_enabled:boolean;daily_upload_hour_cst:number} {
    const value=this.collectionConfigForScope();return {event_upload_enabled:value.uploadEnabled,daily_upload_hour_cst:value.uploadHourCst};
  }
  readiness(): boolean {
    this.read(this.options.devicesPath, db=>db.prepare('SELECT sn FROM device_credential_revocation LIMIT 1').get());
    this.read(this.options.devicesPath,db=>{
      db.prepare('SELECT binding_policy,binding_version,parent_account_id FROM device_registry LIMIT 1').get();
      db.prepare('SELECT sn,binding_policy,binding_version FROM device_binding_state LIMIT 1').get();
    });
    this.read(this.options.configPath, db=>db.prepare('SELECT key FROM device_config LIMIT 1').get());
    return true;
  }
}
