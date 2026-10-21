process.env.SEARCH_WORKER_ACCOUNT_ID='worker';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'search-admin-'));
for (const key of ['CONFIG','PROFILE','DEVICES','ACCOUNTS','CONVERSATION','FEEDBACK']) process.env[`${key}_DB_PATH`] = join(dir, `${key}.db`);
process.env.STUDIO_USER='admin-search-test'; process.env.STUDIO_PASS='synthetic-admin-pass';
process.env.STUDIO_EDITOR_USERS='editor-search-test'; process.env.STUDIO_EDITOR_PASS='synthetic-editor-pass';
process.env.AUTH_JWT_SECRET='synthetic-secret'; process.env.SEARCH_ENABLED='1';
process.env.SEARCH_TASK_DB_PATH=join(dir,'search.db'); process.env.DEEPSEEK_API_KEY='synthetic-key'; process.env.SEARCH_ALLOWED_DOMAINS='cstm.org.cn';
const { Hono } = await import('hono');
const { authRoute } = await import('../src/routes/auth.js');
const { searchAdminRoute } = await import('../src/routes/search-admin.js');
const { closeSearchRuntime } = await import('../src/tools/search-runtime.js');
const { deviceRegistryStore } = await import('../src/device-registry-store.js');
const sn='BJP00326070803800006'; deviceRegistryStore.add(sn,'fixture'); deviceRegistryStore.setAccountId(sn,'synthetic');
const app=new Hono().route('/auth',authRoute).route('/search',searchAdminRoute);
const login=async(username:string,password:string)=>(await (await app.request('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})})).json() as any).token as string;
test('只有admin能查看或开关；失效设备拒绝；关闸立即生效',async()=>{
  const admin=await login('admin-search-test','synthetic-admin-pass');
  const editor=await login('editor-search-test','synthetic-editor-pass');
  const req=(token:string,body?:unknown)=>app.request('/search/settings',{method:body===undefined?'GET':'PUT',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  try {
    assert.equal((await req('bad')).status,401);
    assert.equal((await req(editor)).status,403);
    assert.equal((await req(editor,{enabled:true,tools:false,allowlist:[sn]})).status,403);
    assert.equal((await req(admin,{enabled:true,tools:false,allowlist:[]})).status,400);
    assert.equal((await req(admin,{enabled:true,tools:false,allowlist:[sn]})).status,200);
    assert.equal((await (await req(admin)).json() as any).enabled,true);
    assert.equal((await req(admin,{enabled:false,tools:false,allowlist:[sn]})).status,200);
    assert.equal((await (await req(admin)).json() as any).enabled,false);
    deviceRegistryStore.setStatus(sn,'disabled');
    assert.equal((await req(admin,{enabled:true,tools:false,allowlist:[sn]})).status,400);
  }finally{closeSearchRuntime();}
});
