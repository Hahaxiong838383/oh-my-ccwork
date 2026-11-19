import type {DatabaseSync} from 'node:sqlite';
export type ArkIdentity={sn:string;account_id:string;epoch:number};
/** Small generation counter, not a historical ownership reconstruction. SQL triggers cover all writers. */
export function installArkIdentityEpoch(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS ark_device_epoch(sn TEXT PRIMARY KEY,epoch INTEGER NOT NULL);
 INSERT OR IGNORE INTO ark_device_epoch SELECT sn,1 FROM device_registry;
 CREATE TRIGGER IF NOT EXISTS ark_identity_insert AFTER INSERT ON device_registry BEGIN
  INSERT INTO ark_device_epoch VALUES(NEW.sn,1) ON CONFLICT(sn) DO UPDATE SET epoch=epoch+1; END;
 CREATE TRIGGER IF NOT EXISTS ark_identity_delete AFTER DELETE ON device_registry BEGIN
  INSERT INTO ark_device_epoch VALUES(OLD.sn,1) ON CONFLICT(sn) DO UPDATE SET epoch=epoch+1; END;
 CREATE TRIGGER IF NOT EXISTS ark_identity_update AFTER UPDATE OF account_id,parent_account_id,status ON device_registry
 WHEN NEW.account_id IS NOT OLD.account_id OR NEW.parent_account_id IS NOT OLD.parent_account_id OR NEW.status IS NOT OLD.status BEGIN
  INSERT INTO ark_device_epoch VALUES(NEW.sn,1) ON CONFLICT(sn) DO UPDATE SET epoch=epoch+1; END;
 CREATE TRIGGER IF NOT EXISTS ark_identity_revoke_insert AFTER INSERT ON device_credential_revocation BEGIN
  INSERT INTO ark_device_epoch VALUES(NEW.sn,1) ON CONFLICT(sn) DO UPDATE SET epoch=epoch+1; END;
 CREATE TRIGGER IF NOT EXISTS ark_identity_revoke_delete AFTER DELETE ON device_credential_revocation BEGIN
  INSERT INTO ark_device_epoch VALUES(OLD.sn,1) ON CONFLICT(sn) DO UPDATE SET epoch=epoch+1; END;
 CREATE TRIGGER IF NOT EXISTS ark_identity_revoke_update AFTER UPDATE ON device_credential_revocation BEGIN
  INSERT INTO ark_device_epoch VALUES(NEW.sn,1) ON CONFLICT(sn) DO UPDATE SET epoch=epoch+1; END;`);
}
export function readArkIdentity(db:DatabaseSync,sn:string):ArkIdentity|null {
 if(!/^BJP003\d{14}$/.test(sn))return null;
 const r=db.prepare(`SELECT d.sn,d.account_id,d.status,e.epoch FROM device_registry d JOIN ark_device_epoch e ON e.sn=d.sn WHERE d.sn=?`).get(sn) as {sn:string;account_id:string|null;status:string;epoch:number}|undefined;
 return r?.status==='active'&&r.account_id&&Number.isSafeInteger(r.epoch)?{sn:r.sn,account_id:r.account_id,epoch:r.epoch}:null;
}
