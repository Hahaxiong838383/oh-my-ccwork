import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const cwd='/opt/p003/server';
const folder=path.resolve(process.argv[2]);
assert.ok(folder.startsWith(cwd+'/backups/analytics-windows/window-'));
const statePath=folder+'/state.json';
const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
const envPath=cwd+'/.env.analytics';
const controlPath=cwd+'/data/analytics-control.json';
const ownerPath=cwd+'/data/analytics-window-owner.json';
const twoKeys=['analytics.event_upload_enabled','analytics.daily_upload_hour_cst'];
const cmdEnv=Object.fromEntries(['PATH','HOME','USER','LOGNAME','LANG','PM2_HOME'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
function cmd(program,args){
  const r=spawnSync(program,args,{cwd,env:cmdEnv,encoding:'utf8',timeout:45000});
  if(r.status!==0)throw new Error('COMMAND_FAILED_'+program.replaceAll('/','_'));
  return r.stdout.trim();
}
function atomic(file,value){
  if(fs.existsSync(file))assert.ok(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink());
  const temp=file+'.'+process.pid+'.tmp';
  const fd=fs.openSync(temp,'wx',0o600);
  try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{fs.renameSync(temp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
  finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
const save=()=>atomic(statePath,JSON.stringify(state,null,2)+'\n');
function saveReceipt(name,value){atomic(folder+'/'+name,JSON.stringify(value,null,2)+'\n');}
function setGate(enabled){atomic(controlPath,JSON.stringify({enabled})+'\n');}
function setAllow(value){
  const before=fs.readFileSync(envPath,'utf8');const parsed=parseEnv(before);
  const present=before.split('\n').filter(l=>/^\s*(?:export\s+)?ANALYTICS_SN_ALLOW\s*=/.test(l));
  assert.ok(present.length<=1,'duplicate allowlist key');
  assert.ok((parsed.ANALYTICS_SN_ALLOW??'')===''||(parsed.ANALYTICS_SN_ALLOW??'')===state.sn,'unrelated allowlist ownership');
  const next=present.length?before.replace(/^\s*(?:export\s+)?ANALYTICS_SN_ALLOW\s*=.*$/m,'ANALYTICS_SN_ALLOW='+value):before.trimEnd()+'\nANALYTICS_SN_ALLOW='+value+'\n';
  if(next===before)return false;
  assert.equal(fs.readFileSync(envPath,'utf8'),before,'concurrent env edit');atomic(envPath,next);return true;
}
function readDb(file,fn){const db=new DatabaseSync(file,{readOnly:true});try{db.exec('PRAGMA busy_timeout=250');return fn(db);}finally{db.close();}}
function config(){return readDb(process.env.ANALYTICS_CONFIG_DB_PATH,db=>db.prepare('SELECT scope,key,value_json,rev,updated_at FROM device_config ORDER BY scope,key').all());}
function unrelatedHash(rows){return createHash('sha256').update(JSON.stringify(rows.filter(r=>r.scope!==state.sn||!twoKeys.includes(r.key)))).digest('hex');}
function effective(rows,sn){let enabled=false,hour=23;for(const scope of ['(global)',sn])for(const r of rows.filter(r=>r.scope===scope)){const v=JSON.parse(r.value_json);if(r.key===twoKeys[0]&&typeof v==='boolean')enabled=v;if(r.key===twoKeys[1]&&Number.isInteger(v))hour=v;}return {enabled,hour};}
function subjects(){return readDb(process.env.ANALYTICS_DEVICES_DB_PATH,db=>db.prepare('SELECT sn,status FROM device_registry').all());}
function counts(){return readDb(process.env.ANALYTICS_DB_PATH,db=>Object.fromEntries(['analytics_event','analytics_event_seen','analytics_batch'].map(t=>[t,Number(db.prepare('SELECT count(*) n FROM '+t).get().n)])));}
function pm2(){return JSON.parse(cmd('pm2',['jlist'])).filter(p=>['p003-voice','kidshub-voice','p003-analytics'].includes(p.name)).map(p=>({name:p.name,pid:p.pid,status:p.pm2_env.status,restarts:p.pm2_env.restart_time,script:p.pm2_env.pm_exec_path}));}
function guardVoice(before){const after=pm2();for(const r of before.filter(r=>r.name!=='p003-analytics'))assert.deepEqual(after.find(a=>a.name===r.name),r,'unrelated service changed');return after;}
async function getJson(url,options={}){const r=await fetch(url,{...options,signal:AbortSignal.timeout(7000)});const data=await r.json();return {status:r.status,data,retry:r.headers.get('retry-after')};}
async function health(){const r=await getJson('http://127.0.0.1:3006/internal/analytics/health',{headers:{'X-Analytics-Internal-Token':process.env.ANALYTICS_INTERNAL_SECRET}});assert.equal(r.status,200);return r.data;}
async function ready(allow,gate){const deadline=Date.now()+30000;while(Date.now()<deadline){try{const h=await health();if(h.ready&&h.allowlist_count===allow&&h.gate_enabled===gate)return h;}catch{}await delay(500);}throw new Error('READY_DEADLINE');}
async function login(){const r=await getJson('http://127.0.0.1:3001/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:process.env.STUDIO_USER,password:process.env.STUDIO_PASS})});assert.equal(r.status,200);assert.equal(r.data.role,'admin');return r.data.token;}
async function putKey(token,key,value){const r=await getJson('http://127.0.0.1:3001/api/admin/device-config/sn/'+encodeURIComponent(state.sn),{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({key,value})});assert.equal(r.status,200);assert.equal(r.data.ok,true);return r.data.rev;}
function credential(sn){const now=Math.floor(Date.now()/1000);const a=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');const b=Buffer.from(JSON.stringify({kind:'p003-device',sub:sn,iat:now,exp:now+120})).toString('base64url');const text=a+'.'+b;return text+'.'+createHmac('sha256',process.env.AUTH_JWT_SECRET).update(text).digest('base64url');}
async function proof(){
  const rows=config();const ids=subjects();const target=ids.find(r=>r.sn===state.sn);assert.equal(target?.status,'active');
  assert.deepEqual(effective(rows,state.sn),{enabled:true,hour:0});assert.equal(effective(rows,'').enabled,false);
  const others=ids.filter(r=>r.sn!==state.sn);assert.ok(others.every(r=>effective(rows,r.sn).enabled===false));
  assert.equal(unrelatedHash(rows),state.baseline.unrelated_config_sha256);
  const head={Authorization:'Bearer '+credential(state.sn)};
  const snapshot=await getJson('https://kidshub-ai.hahaxiong.cc/v1/device/config',{headers:head});assert.equal(snapshot.status,200);assert.equal(snapshot.data.analytics.event_upload_enabled,true);assert.equal(snapshot.data.analytics.daily_upload_hour_cst,0);assert.ok(snapshot.data.posture&&snapshot.data.revision&&snapshot.data.schema_version);
  const body=JSON.stringify({schema_version:1,batch_id:'server-window-empty-proof',sent_at_ms:Date.now(),client:{},events:[]});
  const positive=await getJson('https://kidshub-ai.hahaxiong.cc/v1/device/analytics/events:batch',{method:'POST',headers:{...head,'Content-Type':'application/json','X-Request-Id':'server-window-empty-proof'},body});assert.equal(positive.status,400);assert.equal(positive.data.error_code,'INVALID_BATCH');
  const other=others.find(r=>r.status==='active');assert.ok(other);
  const negative=await getJson('https://kidshub-ai.hahaxiong.cc/v1/device/analytics/events:batch',{method:'POST',headers:{Authorization:'Bearer '+credential(other.sn),'Content-Type':'application/json','X-Request-Id':'server-window-other-proof'},body});assert.equal(negative.status,403);assert.equal(negative.data.error_code,'ANALYTICS_DEVICE_NOT_ENABLED');
  return {public_config_status:snapshot.status,revision:snapshot.data.revision,posture_preserved:true,target_empty_probe:positive.status,other_empty_probe:negative.status,other_registry_devices_disabled:others.length,global_upload_enabled:false};
}
function registerExpiry(){
  const now=Math.floor(Date.now()/1000);
  const expiry=state.requested_expires_at===undefined?(now+1800)*1000:Date.parse(state.requested_expires_at);
  assert.ok(Number.isFinite(expiry)&&expiry>(now+60)*1000&&expiry<=(now+86400)*1000,'invalid finite window expiry');
  state.started_at=new Date(now*1000).toISOString();state.expires_at=new Date(expiry).toISOString();
  state.planned_duration_seconds=(expiry-now*1000)/1000;
  const calendar=state.expires_at.replace('T',' ').replace('.000Z',' UTC');
  const base='p003-analytics-window-'+state.id;
  state.timer=base+'.timer';state.service=base+'.service';save();
  const node=process.execPath;const script=path.resolve(process.argv[1]);
  const service='[Unit]\nDescription=P003 single-device analytics window expiry\nAfter=pm2-root.service\nStartLimitIntervalSec=0\n[Service]\nType=oneshot\nUser=root\nWorkingDirectory='+cwd+'\nExecStart='+node+' --experimental-sqlite --env-file=.env.local --env-file=.env.analytics '+script+' '+folder+' close\nTimeoutStartSec=120\nRestart=on-failure\nRestartSec=5\nStandardOutput=append:'+folder+'/close.log\nStandardError=append:'+folder+'/close.log\n';
  const timer='[Unit]\nDescription=Close P003 single-device analytics window\n[Timer]\nOnCalendar='+calendar+'\nAccuracySec=1s\nRandomizedDelaySec=0\nPersistent=true\nUnit='+state.service+'\n[Install]\nWantedBy=timers.target\n';
  atomic(folder+'/close.log','');
  assert.ok(!fs.existsSync('/etc/systemd/system/'+state.service));assert.ok(!fs.existsSync('/etc/systemd/system/'+state.timer));
  atomic('/etc/systemd/system/'+state.service,service);atomic('/etc/systemd/system/'+state.timer,timer);
  cmd('systemd-analyze',['verify','/etc/systemd/system/'+state.service,'/etc/systemd/system/'+state.timer]);
  cmd('systemctl',['daemon-reload']);cmd('systemctl',['enable','--now',state.timer]);
  assert.equal(cmd('systemctl',['is-active',state.timer]),'active');assert.equal(cmd('systemctl',['is-enabled',state.timer]),'enabled');
  state.timer_next=cmd('systemctl',['show',state.timer,'--value','-p','NextElapseUSecRealtime']);assert.ok(state.timer_next.length>8);save();
}
function checkOwner(){if(!fs.existsSync(ownerPath))return false;return JSON.parse(fs.readFileSync(ownerPath,'utf8')).id===state.id;}
async function close(){
  if(!checkOwner()){assert.equal(state.phase,'closed');return {ok:true,already_closed:true};}
  setGate(false);state.phase='closing';save();
  const token=await login();await putKey(token,twoKeys[0],false);await putKey(token,twoKeys[1],0);
  const changed=setAllow('');if(changed)cmd('pm2',['restart','p003-analytics']);
  const h=await ready(0,false);const rows=config();assert.equal(effective(rows,state.sn).enabled,false);assert.equal(effective(rows,'').enabled,false);
  const afterPm=guardVoice(state.baseline.pm2);state.phase='closed';state.closed_at=new Date().toISOString();save();
  fs.unlinkSync(ownerPath);
  const result={ok:true,phase:'closed',device_suffix:state.sn.slice(-8),closed_at:state.closed_at,gate_enabled:h.gate_enabled,allowlist_count:h.allowlist_count,target_upload_enabled:false,counts:counts(),pm2:afterPm.map(({script,...v})=>v)};saveReceipt('closed-receipt.json',result);return result;
}
async function open(){
  assert.equal(state.phase,'prepared');assert.ok(!fs.existsSync(ownerPath),'another window owns control');
  const h=await health();assert.ok(h.ready);assert.equal(h.gate_enabled,false);assert.equal(h.allowlist_count,0);assert.equal(parseEnv(fs.readFileSync(envPath,'utf8')).ANALYTICS_SN_ALLOW??'','');
  const rows=config();const ids=subjects();assert.equal(ids.find(r=>r.sn===state.sn)?.status,'active');assert.equal(effective(rows,state.sn).enabled,false);assert.equal(effective(rows,'').enabled,false);assert.ok(ids.every(r=>effective(rows,r.sn).enabled===false));assert.equal(effective(rows,'').hour,0);
  state.baseline={pm2:pm2(),counts:counts(),unrelated_config_sha256:unrelatedHash(rows)};
  assert.equal(state.baseline.pm2.find(r=>r.name==='p003-analytics')?.script,cwd+'/deploy/analytics-start.ts');
  atomic(folder+'/env.analytics.before',fs.readFileSync(envPath));atomic(folder+'/control.before.json',fs.readFileSync(controlPath));atomic(folder+'/analytics-config.before.json',JSON.stringify(rows,null,2)+'\n');
  save();const fd=fs.openSync(ownerPath,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({id:state.id,folder})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  try{
    const token=await login();setAllow(state.sn);cmd('pm2',['restart','p003-analytics']);await ready(1,false);
    registerExpiry();
    setGate(true);state.gate_opened_at=new Date().toISOString();save();
    const hourRev=await putKey(token,twoKeys[1],0);const enabledRev=await putKey(token,twoKeys[0],true);
    const verified=await proof();const current=await ready(1,true);const afterPm=guardVoice(state.baseline.pm2);
    state.phase='open';state.verified_at=new Date().toISOString();save();
    const result={ok:true,phase:'open',device_suffix:state.sn.slice(-8),request_id_prefix:state.request_id_prefix,started_at:state.started_at,gate_opened_at:state.gate_opened_at,expires_at:state.expires_at,verified_at:state.verified_at,allowlist_count:current.allowlist_count,gate_enabled:current.gate_enabled,upload_enabled:true,daily_upload_hour_cst:0,config_revisions:{hour:hourRev,enabled:enabledRev},timer:state.timer,timer_next:state.timer_next,proof:verified,baseline_counts:state.baseline.counts,current_counts:counts(),pm2:afterPm.map(({script,...v})=>v)};
    saveReceipt('open-receipt.json',result);return result;
  }catch(e){try{const result=await close();saveReceipt('open-failure-closed.json',{...result,reason:e.code??e.message?.split('\n')[0]??'WINDOW_OPEN_FAILED'});}catch{setGate(false);saveReceipt('open-failure-gate-closed.json',{ok:false,gate_enabled:false,recovery_required:true});}throw e;}
}
try{const mode=process.argv[3];assert.ok(mode==='open'||mode==='close');console.log(JSON.stringify(await (mode==='open'?open():close())));}
catch(e){console.error(JSON.stringify({ok:false,phase:state.phase,error:e.code??'WINDOW_OPERATION_FAILED',message:String(e.message??'').replaceAll(state.sn,'***'+state.sn.slice(-8)).slice(0,150)}));process.exitCode=1;}
