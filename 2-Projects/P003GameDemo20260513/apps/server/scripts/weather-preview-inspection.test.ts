import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {authRoute} from '../src/routes/auth.js';
import {RoutingStore} from '../src/tools/search-routing-store.js';
import {defaultRoutingConfig} from '../src/tools/search-routing-config.js';
import {createRoutingAdminRoute} from '../src/routes/search-routing-admin.js';
process.env.STUDIO_USER='weather-test';process.env.STUDIO_PASS='weather-test-only';
const dir=mkdtempSync(join(tmpdir(),'weather-preview-')),store=new RoutingStore(join(dir,'routing.db'));
// The routing subprocess boundary is fixed here; HTTP/resolver behavior remains real.
let place='深圳';let legacy=false;
const app=new Hono();app.route('/auth',authRoute);
app.route('/routing',createRoutingAdminRoute({store:()=>store,scope:()=>[],preview:async()=>({ok:true,decisions:[legacy?{action:'chat',reason:'old preview'}:{action:'search',rule_id:'weather',place_weather:{place,day_offset:1,metric:'forecast'}}]})}));
try {
 const login=await app.request('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'weather-test',password:'weather-test-only'})});
 const token=(await login.json()).token;
 const req=()=>app.request('/routing/preview',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({config:defaultRoutingConfig(),utterances:[{text:'天气测试',at_ms:0}]})});
 for(const [input,status,count] of [['深圳','unique',1],['朝阳','ambiguous',3],['北京大学','unknown',0],['<script>','invalid',0]] as const){
   place=input;const response=await req();assert.equal(response.status,200);
   const result=await response.json(),inspection=result.decisions[0].place_inspection;
   assert.equal(inspection?.status,status,input);assert.equal(inspection.candidates.length,count);
   assert.match(result.weather_catalog.sha256,/^[a-f0-9]{64}$/);assert.equal(result.weather_catalog.count,3220);
   if(status==='unique')assert.equal(inspection.candidates[0].station,'101280601');
 }
 legacy=true;const old=await(await req()).json();assert.equal(old.decisions[0].action,'chat');assert.equal(old.decisions[0].place_inspection,undefined);
 assert.equal(store.state().revision,0,'preview must not publish or modify config');
 console.log('weather preview: unique/ambiguous/unknown/invalid/legacy/no-write passed');
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
