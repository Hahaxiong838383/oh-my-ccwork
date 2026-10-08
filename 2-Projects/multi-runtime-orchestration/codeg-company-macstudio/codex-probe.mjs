import fs from 'node:fs';
const input = JSON.parse(fs.readFileSync(0,'utf8'));
const { token, workingDir, nonce } = input;
const base = 'http://127.0.0.1:3080';
let connectionId=null,sessionId=null,folderId=null,conversationId=null;
let answer='',completed=null,failure=null,connected=false,ready=false;
let toolEvents=0, toolEvidence='';
const eventTypes={};
const permissions=[];
const answeredPermissions=new Set();
const started=Date.now();
async function api(command,body) {
  const response=await fetch(`${base}/api/${command}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  if(!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) throw new Error(`Codeg ${command}: HTTP ${response.status}`);
  return response.json();
}
function consume(e) {
  if(!connectionId || e?.connection_id!==connectionId) return;
  eventTypes[e.type]=(eventTypes[e.type]||0)+1;
  if(e.type==='status_changed') connected=e.status==='connected';
  if(e.type==='session_started') sessionId=e.session_id;
  if(e.type==='conversation_linked') {
    if(e.folder_id!==undefined && e.folder_id!==folderId) failure={code:'wrong_folder',message:'Unexpected conversation folder'};
    else conversationId=e.conversation_id;
  }
  if(e.type==='content_delta') answer+=e.text||'';
  if(e.type==='turn_complete') completed=e;
  if(e.type==='error') failure={code:e.code,message:e.message};
  if(e.type==='tool_call' || e.type==='tool_call_update') {toolEvents++;toolEvidence+=JSON.stringify(e);}
  if(e.type==='permission_request' && !answeredPermissions.has(e.request_id)) permissions.push(e);
}
async function until(predicate,ms,label) {
  const deadline=Date.now()+ms;
  while(Date.now()<deadline) {
    if(failure) throw new Error(`Codeg ${failure.code||'agent_error'}: ${failure.message||''}`);
    while(permissions.length) {
      const request=permissions.shift();
      if(answeredPermissions.has(request.request_id)) continue;
      const raw=JSON.stringify(request.tool_call?.rawInput??request.tool_call?.raw_input??request.tool_call);
      if(!raw.includes('probe-nonce.txt') || !raw.includes('hostname') || !raw.includes('id -u') || /\b(?:rm|curl|wget|sudo|chmod|chown|mv|cp)\b/.test(raw)) throw new Error('Unexpected permission request in read-only deployment probe');
      const choice=request.options?.find(option=>option.kind==='allow_once');
      if(!choice) throw new Error('Missing allow-once permission option');
      answeredPermissions.add(request.request_id);
      await api('acp_respond_permission',{connectionId,requestId:request.request_id,optionId:choice.option_id});
    }
    if(await predicate()) return;
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  throw new Error(`${label} timed out`);
}
const ws=new WebSocket('ws://127.0.0.1:3080/ws/events',['codeg-events',`codeg-token.${Buffer.from(token).toString('base64url')}`]);
ws.addEventListener('error',()=>{failure={code:'websocket',message:'Event WebSocket failed'};});
ws.addEventListener('message',event=>{
  const frame=JSON.parse(event.data);
  if(frame.channel==='__ready__') ready=true;
  if(frame.channel==='acp://event') consume(frame.payload);
  if(frame.type==='event') consume(frame.envelope);
  if(frame.type==='replay') for(const e of frame.events||[]) consume(e);
  if(frame.type==='snapshot' && frame.connection_id===connectionId) {
    sessionId=frame.snapshot?.external_id||sessionId;
    connected=frame.snapshot?.status==='connected';
    if(frame.snapshot?.pending_permission) consume({...frame.snapshot.pending_permission,type:'permission_request',connection_id:connectionId});
  }
});
let report={};
const cleanup={};
try {
  await until(()=>ready,10000,'WebSocket readiness');
  const folder=await api('open_folder',{path:workingDir});
  if(folder.path!==workingDir || !Number.isInteger(folder.id)) throw new Error('Incorrect remote workspace');
  folderId=folder.id;
  connectionId=await api('acp_connect',{agentType:'codex',workingDir,sessionId:null,preferredModeId:null,preferredConfigValues:{}});
  if(typeof connectionId!=='string' || !connectionId) throw new Error('Missing connection ID');
  ws.send(JSON.stringify({action:'attach',subscription_id:'company-studio-deployment-validation',connection_id:connectionId,since_seq:null}));
  await until(()=>connected && sessionId,60000,'Codex initialization');
  await api('acp_prompt',{connectionId,blocks:[{type:'text',text:'这是公司 Mac Studio Codeg 部署验收。请调用工具，在当前工作目录执行这一条只读命令：pwd; id -u; hostname; cat probe-nonce.txt。把命令的实际输出完整原样返回，并在最后回复 CODEG_COMPANY_STUDIO_OK。不要修改任何文件，不要执行其他命令，不要读取工作目录外的文件，不要发网络请求。'}],folderId,conversationId:null,clientMessageId:'company-studio-deployment-validation-20261008'});
  await until(()=>completed!==null,180000,'Codex tool execution and reply');
  if(completed.stop_reason!=='end_turn') throw new Error('Unexpected stop reason '+completed.stop_reason);
  if(!answer.includes(nonce) || !answer.includes('fu-121deMac-Studio.local') || !answer.includes(workingDir) || !/\b501\b/.test(answer) || !answer.includes('CODEG_COMPANY_STUDIO_OK')) throw new Error('Remote identity/nonce reply did not match');
  if(toolEvents===0 || !toolEvidence.includes(nonce)) throw new Error('Missing actual remote tool output');
  report={passed:true,agent:'codex',connection_id:connectionId,session_id:sessionId,folder_id:folderId,conversation_id:conversationId,working_dir:workingDir,reply:answer.trim(),stop_reason:completed.stop_reason,event_types:eventTypes,permissions_allowed_once:answeredPermissions.size,elapsed_seconds:(Date.now()-started)/1000};
} catch(error) {
  report={passed:false,error:error.message,agent:'codex',connection_id:connectionId,session_id:sessionId,event_types:eventTypes,observed_reply:answer,elapsed_seconds:(Date.now()-started)/1000};
} finally {
  if(connectionId) {try {await api('acp_disconnect',{connectionId});cleanup.disconnected=true;}catch(error){cleanup.disconnect_error=error.message;}}
  if(Number.isInteger(conversationId)) {try {await api('delete_conversation',{conversationId});cleanup.conversation_deleted=true;}catch(error){cleanup.conversation_error=error.message;}}
  if(folderId!==null) {try {await api('remove_folder_from_workspace',{folderId});cleanup.folder_closed=true;}catch(error){cleanup.folder_error=error.message;}}
  ws.close();
}
console.log(JSON.stringify({...report,cleanup}));
process.exitCode=report.passed?0:1;
