import {readAdminWeeklyReport,WeeklyReportError} from '../weekly-report-service.js';
import {Hono} from 'hono';
import {taskScopeForDevice,TaskError} from '../parent-tasks/scope.js';
import {taskStore} from '../parent-tasks/store.js';
import {installDeviceTaskSchema,taskProof} from '../parent-tasks/device.js';
import {recordsStore} from '../ark/records-service.js';
import {isValidToken,isAdminRole} from './auth.js';
import {readAdminMiniappDashboardWithHistory,readAdminMiniappObservations,readAdminMiniappRecords,readAdminMiniappConversations,MiniappReadError} from '../miniapp-dashboard.js';
import {ObservationError} from '../history-observations.js';
import {RecordsError} from '../ark/records-contract.js';
import {HistoryError} from '../parent-conversations.js';

/** Mounted after adminDataRoute's permission middleware. Also safe when mounted independently. */
export const miniappAdminRoute=new Hono();
miniappAdminRoute.use('/devices/:sn/miniapp/*',async(c,next)=>{
 c.header('Cache-Control','no-store');
 const token=/^Bearer\s+(.+)$/i.exec(c.req.header('authorization')?.trim()??'')?.[1];
 if(!token||!isValidToken(token))return c.json({ok:false,error:'unauthorized'},401);
 if(!isAdminRole(token))return c.json({ok:false,error:'forbidden_devices'},403);
 await next();
});
miniappAdminRoute.get('/devices/:sn/miniapp/dashboard',async c=>{
 const tz=c.req.query('timezone');
 if(tz&&tz!=='Asia/Shanghai')return c.json({ok:false,error:'invalid_timezone',message:'P0 仅支持 Asia/Shanghai'},400);
 return c.json(await readAdminMiniappDashboardWithHistory(c.req.param('sn')));
});
miniappAdminRoute.get('/devices/:sn/miniapp/observations',async c=>c.json(await readAdminMiniappObservations(c.req.param('sn'),new URL(c.req.url).searchParams)));
miniappAdminRoute.get('/devices/:sn/miniapp/records',c=>c.json({ok:true,data:readAdminMiniappRecords(c.req.param('sn'),new URL(c.req.url).searchParams)}));
miniappAdminRoute.get('/devices/:sn/miniapp/conversations',c=>c.json({ok:true,data:readAdminMiniappConversations(c.req.param('sn'),new URL(c.req.url).searchParams)}));
miniappAdminRoute.get('/devices/:sn/miniapp/parent-tasks',c=>{
 const sn=c.req.param('sn'),scope=taskScopeForDevice(sn);
 if(!scope)return c.json({ok:false,error:'not_found',reason:'resource_not_found'},404);
 const store=taskStore();installDeviceTaskSchema(store.db);
 const data=store.transaction(()=>{
  store.refresh(scope);
  const view=c.req.query('view'),limit=Number(c.req.query('limit')??20);
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new TaskError(400,'bad_request','invalid_pagination');
  const page=store.list(scope,view??'all',limit,c.req.query('cursor'));
  const settlement=c.req.query('settlement_id')??page.items.find(i=>i.settlement_id)?.settlement_id;
  const proof=settlement?taskProof(store.db,scope,settlement):null;
  const audit=settlement&&store.allItems(scope).some(i=>i.settlement_id===settlement)?{
   settlement_id:settlement,wallet_receipt:proof?'accepted':'pending',
   r1_state:proof&&recordsStore().matchedTaskRecord(sn,scope.owner,proof)?'matched':'pending',post_snapshot_id:proof?.post_snapshot_id??null
  }:null;
  if(taskScopeForDevice(sn)?.key!==scope.key)throw new TaskError(404,'not_found','resource_not_found');
  return {...page,audit};
 });
 return c.json({ok:true,data});
});
miniappAdminRoute.get('/devices/:sn/miniapp/weekly-report',async c=>{
 const tz=c.req.query('timezone');
 if(tz&&tz!=='Asia/Shanghai')return c.json({ok:false,error:'invalid_timezone'},400);
 return c.json(await readAdminWeeklyReport(c.req.param('sn'),c.req.query('week_start')));
});
miniappAdminRoute.onError((error,c)=>{
 if(error instanceof TaskError)return c.json({ok:false,error:error.code,reason:error.reason},error.status);
 if(error instanceof WeeklyReportError||error instanceof MiniappReadError||error instanceof RecordsError||error instanceof HistoryError||error instanceof ObservationError)return c.json({ok:false,error:error.message},error.status);
 return c.json({ok:false,error:'dashboard_dependency_unavailable'},503);
});
