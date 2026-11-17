import {Hono} from 'hono';
import {getConnInfo} from '@hono/node-server/conninfo';
import {timingSafeEqual} from 'node:crypto';
import {ZodError,z} from 'zod';
import {realpathSync} from 'node:fs';
import type {ArkStore} from './store.js';
import {arkArchiveCommand} from './archive-commands.js';
import {readBoundedJson,ArkHttpError} from './http.js';
/** Local administrative commands only. Mounted on the existing Brain HTTP server. */
export function createArkArchiveControl(o:{store:()=>ArkStore;secret:()=>string;enabled:()=>boolean}){
 const app=new Hono();let pending=0;
 app.post('/',async c=>{
  c.header('Cache-Control','no-store');
  if(!o.enabled())return c.json({ok:false},404);
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(getConnInfo(c).remote.address??''))return c.json({ok:false},404);
  const want=o.secret(),got=c.req.header('X-Ark-Archive-Token')??'';
  if(want.length<32||Buffer.byteLength(want)!==Buffer.byteLength(got)||!timingSafeEqual(Buffer.from(want),Buffer.from(got)))return c.json({ok:false},401);
  if(pending>=2)return c.json({ok:false,error:'archive_control_busy'},503);
  pending++;try{
   const envelope=z.object({database:z.string().min(1).max(4096),command:z.unknown()}).strict().parse(await readBoundedJson(c.req.raw,8192,1000));
   const store=o.store(),file=String(store.db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file??'');
   if(envelope.database!==realpathSync(file))return c.json({ok:false,error:'archive_database_mismatch'},409);
   // No transaction is retained over an await. File work stays in the exporter.
   return c.json({ok:true,result:arkArchiveCommand(store.db,envelope.command)});
  }catch(e){
   if(e instanceof ArkHttpError)return c.json({ok:false,error:e.message},e.status);
   if(e instanceof ZodError)return c.json({ok:false,error:'invalid_archive_command'},400);
   if(e instanceof Error&&/^archive_[a-z_]+$/.test(e.message))return c.json({ok:false,error:e.message},409);
   return c.json({ok:false,error:'archive_control_unavailable'},503);
  }finally{pending--;}
 });return app;
}
