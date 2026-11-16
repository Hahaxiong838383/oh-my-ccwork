import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const cwd=process.cwd(),root=mkdtempSync(join(tmpdir(),'ark-proxy-service-'));process.chdir(root);
const sn='BJP00399999999999901';Object.assign(process.env,{AUTH_JWT_SECRET:'fake',CUSTOM_LLM_API_KEY:'fake',SEARCH_WORKER_ACCOUNT_ID:'search-canary-worker',SEARCH_CANARY_SN:sn,ARK_FACTS_PROXY_URL:'http://127.0.0.1:8787',ARK_FACTS_PROXY_SECRET:'s'.repeat(40)});
const originalFetch=globalThis.fetch;let calls=0;
globalThis.fetch=async(url,init)=>{calls++;assert.equal(new URL(url as string).hostname,'127.0.0.1');if(JSON.parse(init?.body as string).subject!==sn)return Response.json({ok:false},{status:403});return Response.json({ok:true,prompt:'家族币余额：0'});};
const {arkContext}=await import('../src/ark/service.js');
test('isolated Brain uses current authority grants independently of search SN scope; trusted worker/state question required; never opens ark.db',async()=>{
 try{
 const auth={accountId:'search-canary-worker',role:'device'},room='sn-'+sn+'-123';
 for(const q of [{text:'你好',auth,room},{text:'金币有什么用',auth,room},{text:'金币还有多少',auth:{...auth,accountId:'other'},room},{text:'金币还有多少',auth,room:'sn-BJP00399999999999902-123'},{text:'金币还有多少',auth,room,override:true}])assert.equal((await arkContext(q)).prompt,'');
 assert.equal(calls,1);assert.equal((await arkContext({text:'金币还有多少',auth,room})).prompt,'家族币余额：0');assert.equal(calls,2);process.env.SEARCH_CANARY_SN='';assert.equal((await arkContext({text:'金币还有多少',auth,room})).prompt,'家族币余额：0');assert.equal(existsSync(join(root,'data/ark.db')),false);
 }finally{globalThis.fetch=originalFetch;process.chdir(cwd);rmSync(root,{recursive:true,force:true});}
});
