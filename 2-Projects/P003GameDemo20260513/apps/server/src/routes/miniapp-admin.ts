import {Hono} from 'hono';
import {isValidToken,isAdminRole} from './auth.js';
import {readAdminMiniappDashboard,readAdminMiniappRecords,readAdminMiniappConversations,MiniappReadError} from '../miniapp-dashboard.js';
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
miniappAdminRoute.get('/devices/:sn/miniapp/dashboard',c=>{
 const tz=c.req.query('timezone');
 if(tz&&tz!=='Asia/Shanghai')return c.json({ok:false,error:'invalid_timezone',message:'P0 仅支持 Asia/Shanghai'},400);
 return c.json(readAdminMiniappDashboard(c.req.param('sn')));
});
miniappAdminRoute.get('/devices/:sn/miniapp/records',c=>c.json({ok:true,data:readAdminMiniappRecords(c.req.param('sn'),new URL(c.req.url).searchParams)}));
miniappAdminRoute.get('/devices/:sn/miniapp/conversations',c=>c.json({ok:true,data:readAdminMiniappConversations(c.req.param('sn'),new URL(c.req.url).searchParams)}));
miniappAdminRoute.onError((error,c)=>{
 if(error instanceof MiniappReadError||error instanceof RecordsError||error instanceof HistoryError)return c.json({ok:false,error:error.message},error.status);
 return c.json({ok:false,error:'dashboard_dependency_unavailable'},503);
});
