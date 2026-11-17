import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHmac,randomUUID,randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {probePreflight,chatHeaders} from './probe-preflight.mjs';
const root=process.cwd();
const isolated=process.env.CLOCK_ISOLATED_FULL==='1';assert(root.startsWith('/opt/p003/')||(isolated&&root.startsWith('/root/p003-clock-release-20261117/verify/')));
const {port,secret,key,paths}=probePreflight(process.env,root);
if(process.argv.includes('--preflight')){console.log(JSON.stringify({pass:true,read_only:true,key_required:Boolean(key)}));process.exit(0);}
const sn=process.env.CLOCK_PROBE_SN||('BJP003991231'+String(Date.now()%100000000).padStart(8,'0')),account='clock-release-'+randomUUID();
const db=new DatabaseSync(paths.devices),conv=new DatabaseSync(paths.conversation);db.exec('PRAGMA busy_timeout=3000');conv.exec('PRAGMA busy_timeout=3000');
const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x=>x.name).filter(n=>/^[a-zA-Z0-9_]+$/.test(n)).filter(n=>db.prepare('PRAGMA table_info('+n+')').all().some(c=>c.name==='sn'));
for(const t of tables)assert.equal(Number(db.prepare('SELECT count(*) n FROM '+t+' WHERE sn=?').get(sn).n),0,'synthetic identity must be new');
assert.equal(Number(conv.prepare('SELECT count(*) n FROM conversation WHERE account_id=?').get(account).n),0);
const now=Math.floor(Date.now()/1000),b=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const unsigned=b({alg:'HS256',typ:'JWT'})+'.'+b({accountId:process.env.SEARCH_WORKER_ACCOUNT_ID||'clock-release-controller',role:'device',iss:'p003',aud:'kidshub',iat:now,exp:now+300});const token=unsigned+'.'+createHmac('sha256',secret).update(unsigned).digest('base64url');
const room='sn-'+sn+'-'+Date.now(),rows=[],result={pool:root,port,synthetic:true,rtc_room_created:false,rows,cleanup:false};let inserted=false;
async function chat(text,auth=true){
 const before=Date.now();const url='http://127.0.0.1:'+port+'/v1/chat/completions'+(auth?'?room='+room+'&token='+token:'');
 const r=await fetch(url,{method:'POST',headers:chatHeaders(key),body:JSON.stringify({messages:[{role:'user',content:text}]}),signal:AbortSignal.timeout(30000)});const wire=await r.text();assert.equal(r.status,200);assert(wire.includes('[DONE]'));
 const chunks=wire.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));const spoken=chunks.map(x=>x.choices?.[0]?.delta?.content||'').join('');const after=Date.now();
 rows.push({text,status:r.status,spoken,before_ms:before,after_ms:after,elapsed_ms:after-before,clock_response:chunks.some(x=>x.id?.startsWith('chatcmpl-clock-')),reference_beijing:new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'full',timeStyle:'short'}).format(before)});return rows.at(-1);
}
try{
 const ts=Date.now();db.prepare('INSERT INTO device_registry(sn,note,status,account_id,public_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(sn,'temporary server clock acceptance','active',account,'dev_'+randomBytes(8).toString('hex'),ts,ts);inserted=true;
 for(const q of ['现在几点了','今天是几号呀','今天是周几','纽约现在几点','帮我查当前时间','美国时间']){
  const r=await chat(q);assert(r.clock_response,'must reach deployed clock branch');assert(r.spoken.length>0);if(q==='美国时间')assert.match(r.spoken,/时区/);else assert.doesNotMatch(r.spoken,/查不到|无法|不知道/);
 }
 const cn=s=>{const d={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};s=s.replace(/^零/,'');if(s.includes('十')){const [a,b]=s.split('十');return (a?d[a]:1)*10+(b?d[b]:0);}return d[s]??0;};
 for(const row of rows){if(row.text==='美国时间')continue;const zone=row.text.startsWith('纽约')?'America/New_York':'Asia/Shanghai';const parts=ms=>Object.fromEntries(new Intl.DateTimeFormat('zh-CN',{timeZone:zone,year:'numeric',month:'numeric',day:'numeric',weekday:'long',hour:'numeric',minute:'numeric',hourCycle:'h23'}).formatToParts(ms).map(p=>[p.type,p.value]));const alternatives=[parts(row.before_ms),parts(row.after_ms)];
  if(row.text==='今天是周几'){assert(alternatives.some(p=>row.spoken.includes(p.weekday)));}
  else if(row.text==='今天是几号呀'){assert(alternatives.some(p=>row.spoken.includes(p.year+'年'+p.month+'月'+p.day+'日')));}
  else {const m=/([零一二两三四五六七八九十]+)点(整|([零一二两三四五六七八九十]+)分)/.exec(row.spoken);assert(m,'spoken hour/minute required');const h=cn(m[1]),min=m[2]==='整'?0:cn(m[3]);assert(alternatives.some(p=>h===(Number(p.hour)>12?Number(p.hour)-12:Number(p.hour))&&min===Number(p.minute)),'spoken time must equal independent Intl observation');}
  row.time_verified=true;
 }
 const audits=conv.prepare('SELECT memory_excluded FROM conversation WHERE account_id=?').all(account);assert.equal(audits.length,12);assert(audits.every(r=>r.memory_excluded===1));result.audit_rows=audits.length;
 if(!isolated){const ordinary=await chat('一加一等于几',false);assert(!ordinary.clock_response);assert.match(ordinary.spoken,/二|2|两/);}result.pass=true;
}catch(e){result.pass=false;result.error=String(e.message).replace(/eyJ[A-Za-z0-9_.-]+/g,'[redacted]');}
finally{
 conv.prepare('DELETE FROM conversation WHERE account_id=?').run(account);
 if(inserted){db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM device_registry WHERE sn=? AND account_id=?').run(sn,account);for(const t of tables)if(t!=='device_registry')db.prepare('DELETE FROM '+t+' WHERE sn=?').run(sn);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
 result.cleanup=tables.every(t=>Number(db.prepare('SELECT count(*) n FROM '+t+' WHERE sn=?').get(sn).n)===0)&&Number(conv.prepare('SELECT count(*) n FROM conversation WHERE account_id=?').get(account).n)===0;
 db.close();conv.close();writeFileSync(process.env.CLOCK_PROBE_RESULT,JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify({pool:root,pass:result.pass,rows:rows.length,cleanup:result.cleanup}));if(!result.pass||!result.cleanup)process.exitCode=1;
