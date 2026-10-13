// Root-only preparation using the existing protected JWT secret; no secret output.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, mkdirSync, lstatSync, openSync, fsyncSync, closeSync, fstatSync, constants, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parseEnv } from 'node:util';
const server='/opt/p003/server';assert.equal(resolve(process.cwd()),server);
function capture(path){
 const parents={};let parent=dirname(path);
 while(true){if(existsSync(parent)){const info=lstatSync(parent);assert.ok(info.isDirectory()&&!info.isSymbolicLink(),'unsafe env parent');parents[parent]=[info.dev,info.ino];}const next=dirname(parent);if(next===parent)break;parent=next;}
 let info;try{info=lstatSync(path);}catch(error){if(error.code==='ENOENT')return {identity:null,bytes:null,parents};throw error;}
 assert.ok(info.isFile()&&!info.isSymbolicLink(),'unsafe env target');
 const identity=info=>[info.dev,info.ino,info.mode,info.uid,info.gid,info.size,info.mtimeMs,info.ctimeMs];
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes,after;
 try{const before=fstatSync(fd);bytes=readFileSync(fd);after=fstatSync(fd);assert.deepEqual(identity(info),identity(before));assert.deepEqual(identity(before),identity(after));}finally{closeSync(fd);}
 assert.deepEqual(identity(after),identity(lstatSync(path)),'env changed while reading');
 return {identity:identity(after),bytes,parents};
}
function unchanged(path,expected){const current=capture(path);assert.deepEqual(current.identity,expected.identity,'env target identity changed');assert.ok(current.bytes===null?expected.bytes===null:current.bytes.equals(expected.bytes),'env bytes changed; later edit preserved');for(const [parent,identity] of Object.entries(expected.parents))assert.deepEqual(current.parents[parent],identity,'env parent changed');}
function atomic(path,data,expected=capture(path)){
 const temp=path+'.analytics-preparation.tmp';assert.ok(!existsSync(temp),'preparation temp already exists');
 const fd=openSync(temp,'wx',0o600),owned=fstatSync(fd);
 try{
  try{writeFileSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}
  unchanged(path,expected);renameSync(temp,path);chmodSync(path,0o600);
  const dir=openSync(dirname(path),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
  return capture(path);
 }finally{if(existsSync(temp)){const current=lstatSync(temp);if(current.dev===owned.dev&&current.ino===owned.ino)unlinkSync(temp);}}
}
function lockedMain(){
 const lock=server+'/.analytics-deploy.lock';mkdirSync(lock,{mode:0o700});const owned=lstatSync(lock);
 try{main();}finally{if(existsSync(lock)){const current=lstatSync(lock);if(current.dev===owned.dev&&current.ino===owned.ino)rmdirSync(lock);}}
}
function main(){
 const oldPath=server+'/.env.local';assert.ok(lstatSync(oldPath).isFile()&&!lstatSync(oldPath).isSymbolicLink());const oldState=capture(oldPath),original=oldState.bytes.toString('utf8'),existing=parseEnv(original);assert.ok(existing.AUTH_JWT_SECRET,'existing JWT secret required');
 const envPath=server+'/.env.analytics',reused=existsSync(envPath);let runtimeState=capture(envPath),runtime;
 if(existsSync(envPath)){assert.ok(lstatSync(envPath).isFile()&&!lstatSync(envPath).isSymbolicLink());runtime=parseEnv(runtimeState.bytes.toString('utf8'));assert.equal(runtime.AUTH_JWT_SECRET,existing.AUTH_JWT_SECRET);assert.ok(runtime.ANALYTICS_DEVICE_KEY_SECRET&&runtime.ANALYTICS_INTERNAL_SECRET,'stable secrets unavailable');}
 else{runtime={AUTH_JWT_SECRET:existing.AUTH_JWT_SECRET,ANALYTICS_DEVICE_KEY_SECRET:randomBytes(32).toString('hex'),ANALYTICS_INTERNAL_SECRET:randomBytes(32).toString('hex'),ANALYTICS_DB_PATH:server+'/data/analytics.db',ANALYTICS_DEVICES_DB_PATH:server+'/data/devices.db',ANALYTICS_CONFIG_DB_PATH:server+'/data/config.db',ANALYTICS_CONTROL_PATH:server+'/data/analytics-control.json',ANALYTICS_SN_ALLOW:'',DEVICE_SN_ALLOW:existing.DEVICE_SN_ALLOW||'',ANALYTICS_GLOBAL_RPM:'600',ANALYTICS_BACKUP_DIR:server+'/backups/analytics-daily'};const data=Object.entries(runtime).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n')+'\n';assert.deepEqual(parseEnv(data),runtime,'env round trip');runtimeState=atomic(envPath,data,runtimeState);}
 const priorRuntime=JSON.stringify(runtime);runtime.ANALYTICS_NODE_PATH=runtime.ANALYTICS_NODE_PATH||server+'/.runtime/node-v24.19.0-linux-x64/bin/node';runtime.ANALYTICS_ROLLUP_MAX_DAY_MS='30000';
 if(JSON.stringify(runtime)!==priorRuntime)runtimeState=atomic(envPath,Object.entries(runtime).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n')+'\n',runtimeState);
 assert.notEqual(runtime.ANALYTICS_DEVICE_KEY_SECRET,runtime.ANALYTICS_INTERNAL_SECRET);assert.equal(runtime.ANALYTICS_SN_ALLOW,'','initial deployment requires empty gray list');
 for(const [key,path] of Object.entries({ANALYTICS_DB_PATH:server+'/data/analytics.db',ANALYTICS_DEVICES_DB_PATH:server+'/data/devices.db',ANALYTICS_CONFIG_DB_PATH:server+'/data/config.db'}))assert.equal(runtime[key],path,'production database path mismatch');
 const updates={ANALYTICS_INTERNAL_SECRET:runtime.ANALYTICS_INTERNAL_SECRET,ANALYTICS_INTERNAL_URL:'http://127.0.0.1:3006'};
 for(const [key,value] of Object.entries(updates))assert.ok(!existing[key]||existing[key]===value,'gateway analytics configuration already changed');
 const append=Object.entries(updates).filter(([key])=>!existing[key]).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n');if(append)atomic(oldPath,original+'\n# P003 analytics admin gateway, 2026-10-13\n'+append+'\n',oldState);
 mkdirSync(server+'/data',{recursive:true});const control=runtime.ANALYTICS_CONTROL_PATH;assert.equal(control,server+'/data/analytics-control.json');if(existsSync(control))assert.ok(lstatSync(control).isFile()&&!lstatSync(control).isSymbolicLink());atomic(control,JSON.stringify({enabled:false})+'\n');unchanged(envPath,runtimeState);if((lstatSync(envPath).mode&0o777)!==0o600){chmodSync(envPath,0o600);const secured=capture(envPath);assert.ok(secured.bytes.equals(runtimeState.bytes));runtimeState=secured;}
 if(!existsSync(runtime.ANALYTICS_DB_PATH))writeFileSync(runtime.ANALYTICS_DB_PATH,'',{mode:0o600,flag:'wx'});
 assert.ok(lstatSync(runtime.ANALYTICS_DB_PATH).isFile()&&!lstatSync(runtime.ANALYTICS_DB_PATH).isSymbolicLink());chmodSync(runtime.ANALYTICS_DB_PATH,0o600);
 const protectedPath=server+'/backups/analytics-releases/analytics-release-20261013/protected';mkdirSync(protectedPath,{recursive:true,mode:0o700});unchanged(envPath,runtimeState);atomic(protectedPath+'/.env.analytics',runtimeState.bytes);
 console.log(JSON.stringify({ok:true,existing_runtime_secrets_reused:reused,runtime_secrets_persisted:true,independent_secrets:true,allowlist_count:0,server_gate:false,protected_env_mode:'0600',gateway_keys_configured:true}));
}
try{lockedMain();}catch{console.error('ANALYTICS_PROTECTED_ENV_PREPARATION_FAILED');process.exitCode=1;}
