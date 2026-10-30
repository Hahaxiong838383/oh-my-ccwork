/** Local-only real SQLite/Hono fixture. Never loads .env or connects to production. */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
const source=readFileSync(fileURLToPath(new URL('../../web/public/admin/index.html',import.meta.url)),'utf8');
const dir=mkdtempSync(join(tmpdir(),'p003-listening-ui-'));process.chdir(dir);
for(const key of ['CONFIG','DEVICES','ACCOUNTS','PROFILE','CONVERSATION','FEEDBACK','SMS','PAIRING','OTA','DIAGNOSTICS','TELEMETRY'])process.env[key+'_DB_PATH']=join(dir,key+'.db');
Object.assign(process.env,{STUDIO_USER:'fixture-admin',STUDIO_PASS:'fixture-password',STUDIO_EDITOR_USERS:'fixture-editor',STUDIO_EDITOR_PASS:'fixture-password',STUDIO_GUEST_USER:'fixture-guest',STUDIO_GUEST_PASS:'fixture-password'});
const { authRoute }=await import('../src/routes/auth.js');
const { adminDataRoute }=await import('../src/routes/admin-data.js');
const component=source.split('<!-- listening-control-card:start -->')[1].split('<!-- listening-control-card:end -->')[0];
const functions=source.split('// listening-control-state:start')[1].split('// listening-control-state:end')[0];
const handleLogin=source.slice(source.indexOf('        function handleLogin()'),source.indexOf('        function handleDropdown('));
const deviceApi=source.slice(source.indexOf('        function deviceApi('),source.indexOf('        function loadDevices('));
const app=new Hono();app.route('/api/auth',authRoute);app.route('/api/admin',adminDataRoute);
app.get('/',c=>c.html(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/element-plus@2.9.1/dist/index.css"><style>body{margin:0;background:#f4f7fa;color:#243746;font:14px system-ui}.kh-card{background:white;border:1px solid #e3e9f0;border-radius:10px}.kh-sub{color:#768695;font-size:12px;line-height:1.7}input[type=checkbox]{accent-color:#3879c7}input:disabled,textarea:disabled{opacity:.6}th{padding:8px 0;border-bottom:1px solid #eee}summary::marker{color:#80909f}</style></head><body><main id="app" style="padding:24px;max-width:1120px;margin:auto"><div style="color:#768695;margin-bottom:12px">Worker 管理 / Worker Brain · 本地联调预览</div>${component}</main><script src="https://cdn.jsdelivr.net/npm/vue@3.4.21/dist/vue.global.prod.js"></script><script src="https://cdn.jsdelivr.net/npm/element-plus@2.9.1/dist/index.full.min.js"></script><script>
const {reactive,onMounted,nextTick}=Vue;Vue.createApp({setup(){var token='',authSessionEpoch=0;var canManageInvites={value:true};var loginForm={username:'fixture-admin',password:'fixture-password'},loginLoading={value:false},currentUser={},isLoggedIn={value:false},currentPage={value:'worker'},khNav={value:'brain'};function saveAuth(t){token=t}function loadThemes(){}function initCharts(){}function getToken(){return token}function handleAuthError(){authSessionEpoch++;token='';resetListeningPanel()}${functions}\n${deviceApi}\n${handleLogin}
onMounted(async()=>{const r=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'fixture-admin',password:'fixture-password'})});token=(await r.json()).token;await loadListeningConfig();});
window.listeningTest={state:listeningPanel,login:handleLogin,loginLoading:loginLoading,load:loadListeningConfig,logout:handleAuthError,concurrentUpdate:async()=>{let d=await deviceApi('/api/admin/worker-voice/listening');let settings=JSON.parse(JSON.stringify(d.config));delete settings.revision;delete settings.schema_version;settings.tuning.feedback_max_chars=110;return deviceApi('/api/admin/worker-voice/listening',{method:'PUT',body:JSON.stringify({expected_revision:d.config.revision,settings})});}};
return {listeningPanel,listeningSceneOptions,listeningTime,markListeningDirty,reloadListeningConfig,saveListeningConfig,disableListeningMode,restoreListeningConfig};}}).use(ElementPlus).mount('#app');</script></body></html>`));
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0},info=>console.log(JSON.stringify({url:`http://127.0.0.1:${info.port}`})));
const stop=()=>server.close(()=>{rmSync(dir,{recursive:true,force:true});process.exit(0);});process.on('SIGTERM',stop);process.on('SIGINT',stop);
