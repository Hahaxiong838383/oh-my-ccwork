import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
/** Read only the authoritative registry. Never construct DeviceRegistryStore here (it migrates). */
export function readResumeAuthority(path:string|undefined,sn:string,candidateAccount:string|null):string|null {
 if(!path||!candidateAccount)return null;
 let db:DatabaseSync|undefined;
 try {
  db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA busy_timeout=50');
  const row=db.prepare(`SELECT status,account_id,parent_account_id,updated_at FROM device_registry WHERE sn=?`).get(sn);
  if(!row||row.status!=='active'||!row.account_id)return null;
  const revoke=db.prepare('SELECT not_before_sec,updated_at FROM device_credential_revocation WHERE sn=?').get(sn);
  return createHash('sha256').update(JSON.stringify([sn,candidateAccount,row,revoke??null])).digest('hex');
 } catch {return null;} finally {db?.close();}
}
