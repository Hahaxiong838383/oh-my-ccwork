// One synthetic-room public query through the current main-pool authorization.
// No RTC room/audio, allowlist, policy, quota configuration or real device mutation.
import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createHmac,randomUUID,randomBytes} from 'node:crypto';import {resolve} from 'node:path';import {writeFileSync} from 'node:fs';
const root=process.cwd();assert(root==='/opt/p003/server');const secret=process.env.AUTH_JWT_SECRET;assert(secret);
const db=new DatabaseSync(resolve(root,process.env.DEVICES_DB_PATH||'data/devices.db'));db.exec('PRAGMA busy_timeout=3000');
const sn='BJP003991231'+String(Date.now()%100000000).padStart(8,'0'),account='clock-search-short-'+randomUUID(),room='sn-'+sn+'-'+Date.now();
const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name).filter(x=>/^[a-zA-Z0-9_]+$/.test(x)).filter(x=>db.prepare('PRAGMA table_info('+x+')').all().some(c=>c.name==='sn'));
assert(tables.every(t=>db.prepare('SELECT count(*) n FROM '+t+' WHERE sn=?').get(sn).n===0));
const now=Math.floor(Date.now()/1000),b=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const u=b({alg:'HS256',typ:'JWT'})+'.'+b({accountId:process.env.SEARCH_WORKER_ACCOUNT_ID,role:'device',iss:'p003',aud:'kidshub',iat:now,exp:now+120});const token=u+'.'+createHmac('sha256',secret).update(u).digest('base64url');
const key=process.env.CUSTOM_LLM_API_KEY?.trim(),headers={'content-type':'application/json','x-p003-worker-token':token,...(key?{Authorization:'Bearer '+key}:{})};
const origin='http://127.0.0.1:3001/v1/internal/search-tasks';
async function req(path,body){const r=await fetch(origin+path+'?room='+room,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});return {status:r.status,body:await r.json()};}
const result={at_ms:Date.now(),synthetic:true,rtc_room_created:false,audio_played:false,query:'故宫明天开放吗帮我查一下',scope_changed:false};let id;
try{
 const ts=Date.now();db.prepare('INSERT INTO device_registry(sn,note,status,account_id,public_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(sn,'temporary clock search short check','active',account,'dev_'+randomBytes(8).toString('hex'),ts,ts);
 const route=await req('/routing');result.routing_status=route.status;
 if(route.status!==200){result.allowed=false;result.reason=route.body.error;}
 else{
  result.allowed=true;const version=route.body.snapshot.version;assert(version);const payload={protocol:1,phase:'committed',turn:'time-query-short',query:result.query,routing:{version,rule_id:'builtin-explicit'}};
  const first=await req('',payload);result.submit_status=first.status;
  if(first.status!==202){result.reason=first.body.error;}
  else{
   id=first.body.task.id;const repeat=await req('',payload);assert.equal(repeat.status,202);assert.equal(repeat.body.task.id,id);result.task_id=id;result.duplicate_same_task=true;
   for(let n=0;n<45;n++){
    const r=await req('');assert.equal(r.status,200);result.task=r.body.tasks.find(t=>t.id===id);assert(result.task);
    if(['ready','failed','cancelled','expired'].includes(result.task.status))break;
    await new Promise(r=>setTimeout(r,500));
   }
   result.local_clock_result=Boolean(result.task?.result?.clock);assert.equal(result.local_clock_result,false);
   const cancelled=await req('/'+id+'/cancel',{});result.cancel_status=cancelled.status;assert.equal(cancelled.status,200);
  }
 }
 result.probe_completed=true;
}catch(e){result.probe_completed=false;result.error=e.message;}
finally{
 if(id)await req('/'+id+'/cancel',{}).catch(()=>{});
 db.exec('BEGIN IMMEDIATE');try{for(const t of tables)db.prepare('DELETE FROM '+t+' WHERE sn=?').run(sn);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
 result.identity_cleanup=tables.every(t=>db.prepare('SELECT count(*) n FROM '+t+' WHERE sn=?').get(sn).n===0);db.close();
 writeFileSync('/root/p003-clock-release-20261118/LIVE-SEARCH-SHORT.json',JSON.stringify(result,null,2));
}
console.log(JSON.stringify({probe_completed:result.probe_completed,allowed:result.allowed,submit_status:result.submit_status,status:result.task?.status,duplicate_same_task:result.duplicate_same_task,local_clock_result:result.local_clock_result,reason:result.reason,identity_cleanup:result.identity_cleanup}));
if(!result.probe_completed||!result.identity_cleanup)process.exitCode=1;
