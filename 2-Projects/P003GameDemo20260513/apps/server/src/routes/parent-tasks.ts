import { Hono, type Context } from 'hono';
import { verifyAuthToken } from '../auth-jwt.js';
import { ArkHttpError, readBoundedJson } from '../ark/http.js';
import { objectBody } from '../parent-tasks/rules.js';
import { TaskError, invalid, missing, taskScopeForParent, type TaskScope } from '../parent-tasks/scope.js';
import { taskStore, type TaskStore } from '../parent-tasks/store.js';

export const parentTasksRoute = new Hono();
const base='/:publicId/tasks';
type Input = {store:TaskStore; scope:TaskScope; now:number; body:Record<string,unknown>};
async function handle(c:Context, action:(input:Input)=>object) {
  c.header('Cache-Control','no-store');
  try {
    const token=/^Bearer\s+(.+)$/i.exec(c.req.header('authorization')?.trim()??'')?.[1];
    const auth=await verifyAuthToken(token);
    if (!auth) throw new TaskError(401,'unauthorized',token?'credential_invalid':'credential_missing');
    const publicId=c.req.param('publicId')!;
    const scope=taskScopeForParent(publicId,auth.accountId,auth.role);
    const method=c.req.method;
    const body=method==='POST'||method==='PATCH'?objectBody(await readBoundedJson(c.req.raw,8192)):{};
    const store=taskStore();
    const search=new URL(c.req.url).searchParams;
    const query=Object.fromEntries(search);
    const data=store.transaction(()=>{
      if (taskScopeForParent(publicId,auth.accountId,auth.role).key!==scope.key) throw missing();
      const now=Date.now();
      const run=()=>{
        store.refresh(scope,now);
        return action({store,scope,now,body});
      };
      const result=method==='GET'?run():store.write(scope,method+' '+c.req.path,c.req.header('Idempotency-Key'),{query,body},run);
      if (taskScopeForParent(publicId,auth.accountId,auth.role).key!==scope.key) throw missing();
      return result;
    });
    return c.json({ok:true,data});
  } catch(error) {
    if (error instanceof TaskError) return c.json({ok:false,error:error.code,reason:error.reason},error.status);
    if (error instanceof ArkHttpError) return c.json({ok:false,error:'bad_request',reason:'invalid_body'},error.status);
    c.header('Retry-After','2');
    return c.json({ok:false,error:'temporarily_unavailable',reason:'retry_later'},503);
  }
}
function occurrence(value:unknown) {
  if (typeof value!=='string' || !value.trim() || value.length>256) throw invalid('invalid_occurrence_id');
  return value;
}
parentTasksRoute.get(base,c=>handle(c,({store,scope})=>{
  const view=c.req.query('view')??'active';
  if (view!=='active' && view!=='history') throw invalid('invalid_view');
  return store.list(scope,view,Number(c.req.query('limit')??'20'),c.req.query('cursor'));
}));
parentTasksRoute.post(base,c=>handle(c,({store,scope,body,now})=>store.create(scope,body,now)));
parentTasksRoute.get(base+'/:taskId',c=>handle(c,({store,scope})=>({
  item:store.item(scope,c.req.param('taskId')!,occurrence(c.req.query('occurrence_id'))),wallet:store.wallet(scope)
})));
parentTasksRoute.patch(base+'/:taskId',c=>handle(c,({store,scope,body,now})=>{
  const {occurrence_id,expected_definition_version,...patch}=body;
  return store.edit(scope,c.req.param('taskId')!,occurrence(occurrence_id),expected_definition_version,patch,now);
}));
parentTasksRoute.delete(base+'/:taskId',c=>handle(c,({store,scope,now})=>{
  const version=c.req.query('expected_definition_version');
  if (!version || !/^\d+$/.test(version)) throw invalid('invalid_expected_version');
  return store.remove(scope,c.req.param('taskId')!,occurrence(c.req.query('occurrence_id')),Number(version),now);
}));
parentTasksRoute.post(base+'/:taskId/occurrences/:occurrenceId/confirm',c=>handle(c,({store,scope,body})=>{
  if (Object.keys(body).length) throw invalid('unexpected_confirmation_fields');
  return store.confirm(scope,c.req.param('taskId')!,occurrence(c.req.param('occurrenceId')));
}));
