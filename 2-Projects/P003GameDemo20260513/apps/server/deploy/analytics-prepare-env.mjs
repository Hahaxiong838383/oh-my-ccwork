// Root-only preparation using the existing protected JWT secret; no secret output.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync, lstatSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parseEnv } from 'node:util';
const server='/opt/p003/server';assert.equal(resolve(process.cwd()),server);
function atomic(path,data){const temp=path+'.analytics-preparation.tmp';assert.ok(!existsSync(temp),'preparation temp already exists');const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);chmodSync(path,0o600);const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
function main(){
 const oldPath=server+'/.env.local';assert.ok(lstatSync(oldPath).isFile()&&!lstatSync(oldPath).isSymbolicLink());const original=readFileSync(oldPath,'utf8'),existing=parseEnv(original);assert.ok(existing.AUTH_JWT_SECRET,'existing JWT secret required');
 const envPath=server+'/.env.analytics',reused=existsSync(envPath);let runtime;
 if(existsSync(envPath)){assert.ok(lstatSync(envPath).isFile()&&!lstatSync(envPath).isSymbolicLink());runtime=parseEnv(readFileSync(envPath,'utf8'));assert.equal(runtime.AUTH_JWT_SECRET,existing.AUTH_JWT_SECRET);assert.ok(runtime.ANALYTICS_DEVICE_KEY_SECRET&&runtime.ANALYTICS_INTERNAL_SECRET,'stable secrets unavailable');}
 else{runtime={AUTH_JWT_SECRET:existing.AUTH_JWT_SECRET,ANALYTICS_DEVICE_KEY_SECRET:randomBytes(32).toString('hex'),ANALYTICS_INTERNAL_SECRET:randomBytes(32).toString('hex'),ANALYTICS_DB_PATH:server+'/data/analytics.db',ANALYTICS_DEVICES_DB_PATH:server+'/data/devices.db',ANALYTICS_CONFIG_DB_PATH:server+'/data/config.db',ANALYTICS_CONTROL_PATH:server+'/data/analytics-control.json',ANALYTICS_SN_ALLOW:'',DEVICE_SN_ALLOW:existing.DEVICE_SN_ALLOW||'',ANALYTICS_GLOBAL_RPM:'600',ANALYTICS_BACKUP_DIR:server+'/backups/analytics-daily'};const data=Object.entries(runtime).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n')+'\n';assert.deepEqual(parseEnv(data),runtime,'env round trip');atomic(envPath,data);}
 assert.notEqual(runtime.ANALYTICS_DEVICE_KEY_SECRET,runtime.ANALYTICS_INTERNAL_SECRET);assert.equal(runtime.ANALYTICS_SN_ALLOW,'','initial deployment requires empty gray list');
 for(const [key,path] of Object.entries({ANALYTICS_DB_PATH:server+'/data/analytics.db',ANALYTICS_DEVICES_DB_PATH:server+'/data/devices.db',ANALYTICS_CONFIG_DB_PATH:server+'/data/config.db'}))assert.equal(runtime[key],path,'production database path mismatch');
 const updates={ANALYTICS_INTERNAL_SECRET:runtime.ANALYTICS_INTERNAL_SECRET,ANALYTICS_INTERNAL_URL:'http://127.0.0.1:3006'};
 for(const [key,value] of Object.entries(updates))assert.ok(!existing[key]||existing[key]===value,'gateway analytics configuration already changed');
 const append=Object.entries(updates).filter(([key])=>!existing[key]).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n');if(append)atomic(oldPath,original+'\n# P003 analytics admin gateway, 2026-10-13\n'+append+'\n');
 mkdirSync(server+'/data',{recursive:true});const control=runtime.ANALYTICS_CONTROL_PATH;assert.equal(control,server+'/data/analytics-control.json');if(existsSync(control))assert.ok(lstatSync(control).isFile()&&!lstatSync(control).isSymbolicLink());atomic(control,JSON.stringify({enabled:false})+'\n');chmodSync(envPath,0o600);
 if(!existsSync(runtime.ANALYTICS_DB_PATH))writeFileSync(runtime.ANALYTICS_DB_PATH,'',{mode:0o600,flag:'wx'});
 assert.ok(lstatSync(runtime.ANALYTICS_DB_PATH).isFile()&&!lstatSync(runtime.ANALYTICS_DB_PATH).isSymbolicLink());chmodSync(runtime.ANALYTICS_DB_PATH,0o600);
 const protectedPath=server+'/backups/analytics-releases/analytics-release-20261013/protected';mkdirSync(protectedPath,{recursive:true,mode:0o700});atomic(protectedPath+'/.env.analytics',readFileSync(envPath));
 console.log(JSON.stringify({ok:true,existing_runtime_secrets_reused:reused,runtime_secrets_persisted:true,independent_secrets:true,allowlist_count:0,server_gate:false,protected_env_mode:'0600',gateway_keys_configured:true}));
}
try{main();}catch{console.error('ANALYTICS_PROTECTED_ENV_PREPARATION_FAILED');process.exitCode=1;}
