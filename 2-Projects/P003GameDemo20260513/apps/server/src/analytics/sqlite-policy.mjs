// Shared by every connection that writes/checkpoints the live analytics database.
export const DEFAULT_ANALYTICS_NODE_PATH='/opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node';
export const ANALYTICS_WAL_MAX_BYTES=256*1024*1024;
export function assertSafeSqliteVersion(version){
 const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(version);
 if(!match)throw new Error('UNSAFE_ANALYTICS_SQLITE_VERSION');
 const [major,minor,patch]=match.slice(1).map(Number);
 const safe=major===3&&((minor>51)||(minor===51&&patch>=3)||(minor===50&&patch>=7)||(minor===44&&patch>=6));
 if(!safe)throw new Error('UNSAFE_ANALYTICS_SQLITE_VERSION');
}
export function configureAnalyticsWriter(db){
 const version=db.prepare('SELECT sqlite_version() version').get().version;
 assertSafeSqliteVersion(version); // Before journal changes, DDL or DML.
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=250;');
 return version;
}
export function validateWalMaxBytes(value){
 if(!Number.isInteger(value)||value<64*1024||value>ANALYTICS_WAL_MAX_BYTES)throw new Error('INVALID_ANALYTICS_WAL_MAX_BYTES');
 return value;
}
