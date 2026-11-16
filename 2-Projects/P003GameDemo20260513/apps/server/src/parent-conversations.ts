import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {Hono} from 'hono';
import {z} from 'zod';
import {accountStore} from './account-store.js';
import {verifyAuthToken} from './auth-jwt.js';

// Explicitly reviewed history authorization, never inferred from the device's current owner.
const safe=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier=z.string().min(1).max(256);
const ScopeSchema=z.object({public_id:z.string().regex(/^dev_[a-f0-9]{16}$/),sn:z.string().regex(/^BJP003\d{14}$/),
 parent_account_id:identifier,account_id:identifier,binding_version:safe,epoch:safe.min(1)}).strict();
type Scope=z.infer<typeof ScopeSchema>;
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return Number.isFinite(+d)&&d.toISOString().slice(0,10)===s;});
const QuerySchema=z.object({limit:z.coerce.number().int().min(1).max(50).default(20),cursor:z.string().min(1).max(4096).optional(),from_day:day.optional(),to_day:day.optional()}).strict()
 .refine(q=>!q.from_day||!q.to_day||q.from_day<=q.to_day,'invalid_day_range');
type Query=z.infer<typeof QuerySchema>;
const CursorSchema=z.object({v:z.literal(1),scope:identifier,filter:identifier,water:safe,anchor:identifier,
 expires:safe,last:z.object({ts:safe,id:identifier}).strict()}).strict();
type Cursor=z.infer<typeof CursorSchema>;
type Stats={message_count:number;user_message_count:number;assistant_message_count:number;first_message_at_ms:number|null;last_message_at_ms:number|null};
type Message={id:string;role:'user'|'assistant';text:string;ts:number};
class HistoryError extends Error {constructor(public status:400|401|404|410|503,code:string){super(code);}}
const unavailable=(reason:'not_enabled'|'dependency_unavailable')=>({available:false,reason,source:'conversation',history_complete:false,
 message_count:null,user_message_count:null,assistant_message_count:null,first_message_at_ms:null,last_message_at_ms:null});
function configuredScope():Scope|null {
 const raw=process.env.PARENT_CONVERSATION_SCOPE_JSON?.trim();if(!raw)return null;
 try{return ScopeSchema.parse(JSON.parse(raw));}catch{throw new HistoryError(503,'conversation_configuration_invalid');}
}
function scopeFor(publicId:string,owner:string):Scope {
 const scope=configuredScope();
 if(!scope||scope.public_id!==publicId||scope.parent_account_id!==owner||accountStore.findAccount(scope.account_id)?.role!=='device')throw new HistoryError(404,'not_found');
 return scope;
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function cursorKey(){const secret=process.env.AUTH_JWT_SECRET;if(!secret)throw new HistoryError(503,'conversation_dependency_unavailable');return createHash('sha256').update('p003.parent.conversations.v1\0'+secret).digest();}
function encodeCursor(cursor:Cursor){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',cursorKey(),iv),body=Buffer.concat([cipher.update(JSON.stringify(cursor),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');}
function decodeCursor(value:string):Cursor {
 const key=cursorKey();
 try{
  if(!/^[A-Za-z0-9_-]+$/.test(value))throw Error();
  const data=Buffer.from(value,'base64url');if(data.length<29||data.toString('base64url')!==value)throw Error();
  const decipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));
  return CursorSchema.parse(JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8')));
 }catch{throw new HistoryError(400,'invalid_cursor');}
}

class ParentConversationReader {
 private db:DatabaseSync;
 constructor(conversationPath:string,devicesPath:string){
  this.db=new DatabaseSync(conversationPath,{readOnly:true});
  try{
   this.db.exec('PRAGMA busy_timeout=100; PRAGMA query_only=ON;');
   const uri=pathToFileURL(devicesPath);uri.searchParams.set('mode','ro');
   this.db.prepare('ATTACH DATABASE ? AS devices').run(uri.toString());
  }catch(error){this.db.close();throw error;}
 }
 close(){this.db.close();}
 private checkScope(scope:Scope){
  const row=this.db.prepare(`SELECT d.sn,d.public_id,d.parent_account_id,d.account_id,d.binding_version,e.epoch,d.status,
   (SELECT COUNT(*) FROM devices.device_registry other WHERE other.account_id=d.account_id) account_uses
   FROM devices.device_registry d JOIN devices.ark_device_epoch e ON e.sn=d.sn WHERE d.public_id=?`).get(scope.public_id);
  if(!row||row.status!=='active'||row.account_uses!==1||Object.entries(scope).some(([key,value])=>row[key]!==value))throw new HistoryError(404,'not_found');
 }
 private snapshot<T>(scope:Scope,fn:()=>T):T {
  this.db.exec('BEGIN');
  try{
   this.checkScope(scope);
   const result=fn();this.db.exec('COMMIT');
   // Attached WAL databases establish independent snapshots. Re-read authority after releasing them:
   // monotonic binding_version/epoch detects a rebind (including A→B→A) during the history read.
   this.checkScope(scope);return result;
  }catch(error){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
 }
 private where(scope:Scope,query:Pick<Query,'from_day'|'to_day'>,water:number){
  let sql="c.account_id=? AND c.rowid<=? AND c.role IN ('user','assistant')";const args:(string|number)[]=[scope.account_id,water];
  if(query.from_day){sql+=' AND c.ts>=?';args.push(Date.parse(query.from_day+'T00:00:00+08:00'));}
  if(query.to_day){sql+=' AND c.ts<?';args.push(Date.parse(query.to_day+'T00:00:00+08:00')+86400000);}
  return {sql,args};
 }
 private highWater(scope:Scope){return this.db.prepare('SELECT rowid water,id anchor FROM conversation WHERE account_id=? ORDER BY rowid DESC LIMIT 1').get(scope.account_id) as {water:number;anchor:string}|undefined;}
 private stats(where:ReturnType<ParentConversationReader['where']>):Stats {
  return this.db.prepare(`SELECT COUNT(*) message_count,COALESCE(SUM(c.role='user'),0) user_message_count,
   COALESCE(SUM(c.role='assistant'),0) assistant_message_count,MIN(c.ts) first_message_at_ms,MAX(c.ts) last_message_at_ms
   FROM conversation c WHERE ${where.sql}`).get(...where.args) as Stats;
 }
 summary(scope:Scope){return this.snapshot(scope,()=>{
  const water=this.highWater(scope)?.water??0;
  return {available:true,reason:null,source:'conversation',history_complete:false,...this.stats(this.where(scope,{},water))};
 });}
 page(scope:Scope,query:Query){return this.snapshot(scope,()=>{
  const scopeHash=hash(scope),filterHash=hash({limit:query.limit,from_day:query.from_day??null,to_day:query.to_day??null});
  const cursor=query.cursor?decodeCursor(query.cursor):null,now=Date.now();
  if(cursor&&(cursor.scope!==scopeHash||cursor.filter!==filterHash))throw new HistoryError(400,'invalid_cursor');
  if(cursor&&cursor.expires<=now)throw new HistoryError(410,'cursor_expired');
  if(cursor&&!this.db.prepare('SELECT 1 FROM conversation WHERE rowid=? AND id=? AND account_id=?').get(cursor.water,cursor.anchor,scope.account_id))throw new HistoryError(410,'cursor_expired');
  const high=cursor?{water:cursor.water,anchor:cursor.anchor}:this.highWater(scope);
  const where=this.where(scope,query,high?.water??0),args=[...where.args];let after='';
  if(cursor){after=' AND (c.ts<? OR (c.ts=? AND c.id<?))';args.push(cursor.last.ts,cursor.last.ts,cursor.last.id);}
  const rows=this.db.prepare(`SELECT c.id,c.role,c.text,c.ts FROM conversation c WHERE ${where.sql}${after} ORDER BY c.ts DESC,c.id DESC LIMIT ?`).all(...args,query.limit+1) as Message[];
  const has_more=rows.length>query.limit,items=rows.slice(0,query.limit),last=items.at(-1);
  const next_cursor=has_more&&last&&high?encodeCursor({v:1,scope:scopeHash,filter:filterHash,...high,expires:cursor?.expires??now+1800000,last:{ts:last.ts,id:last.id}}):null;
  return {schema_version:1,items,next_cursor,has_more,...this.stats(where),history_complete:false};
 });}
}

let reader:ParentConversationReader|undefined,readerPaths='';
function historyReader(){
 const conversationPath=resolve(process.env.CONVERSATION_DB_PATH?.trim()||'./data/conversation.db');
 const devicesPath=resolve(process.env.DEVICES_DB_PATH?.trim()||'./data/devices.db');const paths=JSON.stringify([conversationPath,devicesPath]);
 if(readerPaths!==paths){reader?.close();reader=undefined;readerPaths=paths;}
 return reader??=(new ParentConversationReader(conversationPath,devicesPath));
}
export function parentConversationSummary(publicId:string,owner:string,role:string){
 try{
  if(role!=='parent')return unavailable('not_enabled');
  const scope=scopeFor(publicId,owner);
  if(accountStore.findAccount(owner)?.role!=='parent')return unavailable('not_enabled');
  return historyReader().summary(scope);
 }
 catch(error){return unavailable(error instanceof HistoryError&&error.status===404?'not_enabled':'dependency_unavailable');}
}
export const parentConversationsRoute=new Hono();
parentConversationsRoute.use('/:publicId/conversations',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
parentConversationsRoute.get('/:publicId/conversations',async c=>{
 const auth=await verifyAuthToken(/^Bearer\s+(.+)$/i.exec(c.req.header('authorization')?.trim()??'')?.[1]);
 if(!auth||auth.role!=='parent'||accountStore.findAccount(auth.accountId)?.role!=='parent')throw new HistoryError(401,'unauthorized');
 const scope=scopeFor(c.req.param('publicId'),auth.accountId);
 const params=new URL(c.req.url).searchParams;
 if([...params.keys()].some(key=>params.getAll(key).length!==1))throw new HistoryError(400,'invalid_query');
 const parsed=QuerySchema.safeParse(Object.fromEntries(params));if(!parsed.success)throw new HistoryError(400,'invalid_query');
 return c.json({ok:true,data:historyReader().page(scope,parsed.data)});
});
parentConversationsRoute.onError((error,c)=>{const e=error instanceof HistoryError?error:new HistoryError(503,'conversation_dependency_unavailable');return c.json({ok:false,error:e.message},e.status);});
