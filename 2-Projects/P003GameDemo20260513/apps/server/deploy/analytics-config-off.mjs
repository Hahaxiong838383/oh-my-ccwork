// Run with the server's protected --env-file; never pass credentials in argv.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
const cwd=resolve(process.cwd());
assert.ok(cwd==='/opt/p003/server'||cwd==='/opt/p003/analytics-staging-20261013/server','approved server cwd required');
const base=cwd.includes('analytics-staging')?'http://127.0.0.1:3005':'http://127.0.0.1:3001';
async function main(){
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:process.env.STUDIO_USER,password:process.env.STUDIO_PASS}),signal:AbortSignal.timeout(5000)});
 assert.equal(login.status,200,'admin login unavailable');const auth=await login.json();assert.equal(auth.role,'admin');
 async function api(path,body){const response=await fetch(base+'/api/admin/device-config'+path,{method:body?'PUT':'GET',headers:{Authorization:'Bearer '+auth.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});assert.equal(response.status,200,'configuration request failed');const data=await response.json();assert.equal(data.ok,true);return data;}
 const current=await api('');const key='analytics.event_upload_enabled';assert.ok(current.keys.some(item=>item.key===key),'analytics keys unavailable');
 const global=await api('/global',{key,value:false});let overrides=0;
 for(const item of current.overrides.filter(item=>item.key===key&&item.value!==false)){await api('/sn/'+encodeURIComponent(item.sn),{key,value:false});overrides++;}
 let hour=null;if(process.argv.includes('--initialize-closed'))hour=(await api('/global',{key:'analytics.daily_upload_hour_cst',value:0})).rev;
 const verified=await api('');assert.equal(verified.keys.find(item=>item.key===key).global,false);assert.ok(verified.overrides.filter(item=>item.key===key).every(item=>item.value===false));
 console.log(JSON.stringify({ok:true,upload_enabled:false,global_revision:global.rev,disabled_overrides:overrides,initialized_hour_cst:hour===null?null:0,hour_revision:hour}));
}
try{await main();}catch{console.error('ANALYTICS_CONFIG_OFF_FAILED');process.exitCode=1;}
