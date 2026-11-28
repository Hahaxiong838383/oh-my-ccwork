import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {createConsoleActivity} from './console-activity.js';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import {PersonalMemoryActions, parseMemoryCommand} from './memory-actions.js';
import {PersonalRecall} from './memory-recall.js';
import {TRAIT_DIMS, TRAIT_LABELS, traitStore} from './p003/trait-store.js';
import {relationStateStore} from './p003/relation-state-store.js';
import {isCrisisContent} from './p003/memory-safety-filter.js';

const switches = z.object({search:z.boolean(),weather:z.boolean(),clock:z.boolean()}).strict();
const styles = z.enum(['default','quiet','chatty','funny']);
const writeTools = switches.extend({previous:switches}).strict();
const page = z.object({offset:z.coerce.number().int().min(0).max(1_000_000).default(0),limit:z.coerce.number().int().min(1).max(100).default(25)}).strict();
export type ConsoleTools = z.infer<typeof switches>;
const defaults: ConsoleTools = {search:true,weather:true,clock:true};
const sha = (s:string) => createHash('sha256').update(s).digest();
const secret = /密钥|密码|口令|身份证|银行卡|api[ _-]?key|access[ _-]?token|bearer\s|[a-z0-9_-]{32,}|[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu;
function safe(value:unknown,max=180) {
  const s=typeof value==='string'?value:'';
  return secret.test(s)||isCrisisContent(s)?'（已隐藏敏感内容）':s.slice(0,max);
}
type HttpErrorCode = 400|404|409;
class ConsoleError extends Error {
  constructor(readonly status:HttpErrorCode, line:string) {super(line);}
}
const conflict = () => new ConsoleError(409,'内容已变化，请刷新后重试');
const missing = () => new ConsoleError(404,'未找到这条记录');
function validate<T>(schema:z.ZodType<T,any,any>,raw:unknown):T {
  const result=schema.safeParse(raw);
  if (!result.success) throw new ConsoleError(400,'参数格式无效');
  return result.data;
}
type MemoryRow = {id:string;kind:string;topic:string;value:string;source:string;updatedAt:number|null;manageable:boolean;editable:boolean;itemId?:string};
type GrowthRow = {id:string;at:number;module:string;dimension:string;from:string;to:string;reason:string;rule:string;quote:string;replyId:string|null;feedbackId:string|null;example:string|null;question:string|null;revokedAt:number|null;rowNumber:number};

export class OwnerConsole {
  private readonly db: DatabaseSync;
  private readonly searchlog: DatabaseSync;
  constructor(private readonly dir:string, private readonly owner:string, private readonly memory:PersonalMemoryActions, private readonly recall:PersonalRecall) {
    this.db=new DatabaseSync(join(dir,'profile.sqlite'));
    this.db.exec('PRAGMA busy_timeout=3000');
    this.searchlog = new DatabaseSync(join(dir,'search.sqlite'));
    this.searchlog.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS personal_tool_result(id INTEGER PRIMARY KEY,account_id TEXT NOT NULL,at INTEGER NOT NULL,
      tool TEXT NOT NULL,outcome TEXT NOT NULL,source_count INTEGER,turn_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS personal_tool_at ON personal_tool_result(account_id,at DESC,id DESC)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS personal_tool_settings(account_id TEXT PRIMARY KEY, search INTEGER NOT NULL, weather INTEGER NOT NULL, clock INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_growth_revoke(account_id TEXT NOT NULL,event_id TEXT NOT NULL,ts INTEGER NOT NULL, PRIMARY KEY(account_id,event_id))`);
  }
  tools():ConsoleTools {
    const r=this.db.prepare('SELECT search,weather,clock FROM personal_tool_settings WHERE account_id=?').get(this.owner);
    return r?{search:!!r.search,weather:!!r.weather,clock:!!r.clock}:{...defaults};
  }
  private toolChange(input:z.infer<typeof writeTools>) {
    const actual=this.tools();
    if ((Object.keys(actual) as (keyof ConsoleTools)[]).some(k=>input.previous[k]!==actual[k])) throw conflict();
    this.db.prepare(`INSERT INTO personal_tool_settings(account_id,search,weather,clock) VALUES (?,?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET search=excluded.search, weather=excluded.weather, clock=excluded.clock`)
      .run(this.owner,+input.search,+input.weather,+input.clock);
  }
  private style() {return traitStore.getTemplate(this.owner) ?? 'default';}
  private memories():MemoryRow[] {
    const entries=this.recall.evidence(this.owner);
    const rows:MemoryRow[]=[];
    const verifiedIds=new Set<string>();
    for (const e of entries) {
      if (e.id) verifiedIds.add(e.id);
      const editable=['fact','name','preference'].includes(e.kind) && safe(e.value)===e.value && safe(e.topic)===e.topic;
      rows.push({id:sha(JSON.stringify([e.kind,e.topic,e.quote,e.updatedAt??null,e.id??null])).toString('hex'),
        kind:e.kind,topic:safe(e.topic),value:safe(e.value),source:safe(e.quote),updatedAt:e.updatedAt??null,
        manageable:editable||!!e.id,editable,itemId:e.id});
    }
    const knownTopics = new Set(entries.map(row=>JSON.stringify([row.kind,row.topic])));
    const saved = this.db.prepare('SELECT kind,topic,value,updated_at FROM personal_memory_fact WHERE account_id=?').all(this.owner);
    for (const row of saved) {
      const kind=String(row.kind), topic=String(row.topic), value=String(row.value);
      if (knownTopics.has(JSON.stringify([kind,topic]))) continue;
      const editable=['fact','name','preference'].includes(kind) && safe(topic)===topic && safe(value)===value;
      rows.push({id:sha(JSON.stringify(['unverified',kind,topic,value,row.updated_at])).toString('hex'),
        kind,topic:safe(topic),value:safe(value),source:'未找到可核验的主人原话',updatedAt:Number(row.updated_at),
        manageable:editable,editable});
    }
    // Keep old unverified items inspectable without treating them as evidence in a reply.
    const others=this.db.prepare("SELECT id,type,content,source_quote,created_at FROM memory_item WHERE account_id=? AND status='active' AND source!='personal-owner' ORDER BY created_at DESC,rowid DESC").all(this.owner);
    for (const r of others) {
      const id=String(r.id);
      if (!verifiedIds.has(id)) rows.push({id:sha('item:'+id).toString('hex'),kind:String(r.type),topic:'待核验条目',value:safe(r.content),
        source:'未达到语音召回的证据要求',updatedAt:Number(r.created_at),manageable:true,editable:false,itemId:id});
    }
    return rows.sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)||a.id.localeCompare(b.id));
  }
  private writeMemory(text:string, expected?:MemoryRow) {
    const parsed=parseMemoryCommand(text);
    if (!parsed || parsed.op!=='set' || secret.test(text) || isCrisisContent(text))
      throw new ConsoleError(400,'请写明要记住的称呼、偏好或事实');
    if (expected && (parsed.facts.length!==1 || parsed.facts[0].kind!==expected.kind || parsed.facts[0].topic!==expected.topic)) throw new ConsoleError(400,'新内容与所选记忆不匹配');
    this.memory.apply(parsed,'owner-console',text);
  }
  private changeMemory(id:string,expected:string,value?:string) {
    const r=this.memories().find(row=>row.id===id);
    if (!r) throw missing();
    if (r.value!==expected) throw conflict();
    if (!r.manageable || (value!==undefined && !r.editable)) throw new ConsoleError(400,'此类记忆不能这样修改');
    if (value!==undefined) {
      const phrase=r.kind==='name'?'以后叫我'+value:r.kind==='preference'?'我'+value+r.topic:'我的'+r.topic+'是'+value;
      if (r.kind==='preference' && !['喜欢','不喜欢'].includes(value)) throw new ConsoleError(400,'偏好只能设为喜欢或不喜欢');
      this.writeMemory('记住，'+phrase,r);
    } else {
      const kind=r.kind==='name'||r.kind==='preference'||r.kind==='fact'?r.kind:undefined;
      this.memory.apply({op:'forget',target:{topic:r.topic,kind,itemId:r.editable?undefined:r.itemId}},
        'owner-console','在私人后台忘记所选的一条记忆');
    }
  }
  private growthRows(where:string, params:(number|string)[]):GrowthRow[] {
    return this.db.prepare(`SELECT e.id,e.rowid AS rowNumber,e.ts AS at,e.module,e.dimension,e.from_val AS "from",e.to_val AS "to",e.note AS reason,e.rule,
      e.trigger_quote AS quote,e.reply_msg_id AS replyId,e.feedback_msg_id AS feedbackId,
      s.xiaoke_did AS example,s.child_said AS question,r.ts AS revokedAt FROM growth_event e
      LEFT JOIN style_pool s ON s.id=e.id AND s.account_id=e.account_id LEFT JOIN personal_growth_revoke r ON r.event_id=e.id AND r.account_id=e.account_id
      WHERE e.account_id=? ${where}`).all(this.owner,...params) as unknown as GrowthRow[];
  }
  private growthReason(row:GrowthRow) {
    if (row.revokedAt) return '已经撤销';
    if (!row.replyId || !row.feedbackId) return '历史观察记录';
    if (row.rule==='explicit_style_feedback') return row.example===null?'样例已移除':'';
    if (row.rule!=='explicit_story_feedback' || row.dimension!==TRAIT_LABELS.storytelling) return '观察记录';
    // Removing an old delta after a newer setting changed the same dimension would undo the wrong decision.
    const next=this.db.prepare("SELECT 1 FROM growth_event WHERE account_id=? AND module='trait' AND dimension=? AND rowid>? LIMIT 1").get(this.owner,row.dimension,row.rowNumber);
    return next || Math.abs(traitStore.get(this.owner).storytelling-Number(row.to))>1e-8?'该特质已有后续变化':'';
  }
  private revoke(id:string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row=this.growthRows('AND e.id=?',[id])[0];
      if (!row) throw missing();
      if (!row.revokedAt) {
        const reason=this.growthReason(row);
        if (reason) throw new ConsoleError(409,reason);
        const ts=Date.now();
        if (row.rule==='explicit_style_feedback') this.db.prepare('DELETE FROM style_pool WHERE account_id=? AND id=?').run(this.owner,id);
        else {
          this.db.prepare('UPDATE trait_state SET storytelling=?,updated_at=? WHERE account_id=?').run(Number(row.from),ts,this.owner);
          this.db.prepare(`INSERT INTO growth_event(id,account_id,ts,module,dimension,from_val,to_val,rule,theory,note)
            VALUES(?,?,?,'trait',?,?,?,'rollback','setpoint','主人在私人后台撤销这次特质变化')`).run(randomUUID(),this.owner,ts,row.dimension,row.to,row.from);
        }
        this.db.prepare('INSERT INTO personal_growth_revoke VALUES(?,?,?)').run(this.owner,id,ts);
      }
      this.db.exec('COMMIT');
    } catch (error) {this.db.exec('ROLLBACK');throw error;}
  }
  private count(table:'growth_event'|'tasks'|'personal_tool_result') {
    if (table==='tasks') return Number(this.searchlog.prepare("SELECT COUNT(*) AS n FROM tasks WHERE subject=? AND session NOT GLOB 'admin-diagnostic-*'").get(this.owner)?.n ?? 0);
    if (table==='personal_tool_result') return Number(this.searchlog.prepare('SELECT COUNT(*) AS n FROM personal_tool_result WHERE account_id=? AND at>=?').get(this.owner,Date.now()-7*86_400_000)?.n ?? 0);
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM growth_event WHERE account_id=?').get(this.owner)?.n ?? 0);
  }
  recordTool(tool:string,sources:number|undefined,turnMs:number) {
    if (!['clock','weather','search','search_cancel','memory','memory_action','style','capabilities'].includes(tool)) return;
    const now=Date.now();
    this.searchlog.exec('BEGIN IMMEDIATE');
    try {
      this.searchlog.prepare('INSERT INTO personal_tool_result(account_id,at,tool,outcome,source_count,turn_ms) VALUES(?,?,?,?,?,?)')
        .run(this.owner,now,tool,sources===undefined?'handled':sources?'with_sources':'without_sources',sources??null,Math.round(turnMs));
      this.searchlog.prepare('DELETE FROM personal_tool_result WHERE account_id=? AND (at<? OR id <= COALESCE((SELECT id FROM personal_tool_result WHERE account_id=? ORDER BY id DESC LIMIT 1 OFFSET 1000),-1))')
        .run(this.owner,now-7*86_400_000,this.owner);
      this.searchlog.exec('COMMIT');
    } catch (e) { this.searchlog.exec('ROLLBACK'); throw e; }
  }
  private overview() {
    const state=traitStore.get(this.owner), baseline=traitStore.baselineFor(this.owner);
    const stats=this.searchlog.prepare(`SELECT COUNT(*) AS total,COUNT(*) FILTER (WHERE json_extract(body,'$.outcome')='answered') AS answered,
      COUNT(*) FILTER (WHERE json_extract(body,'$.outcome')='no_evidence') AS noEvidence,
      COUNT(*) FILTER (WHERE json_extract(body,'$.outcome')='failed' OR json_extract(body,'$.failure.stage') IS NOT NULL) AS failed
      FROM tasks WHERE subject=? AND session NOT GLOB 'admin-diagnostic-*'`).get(this.owner);
    return {style:this.style(),traits:TRAIT_DIMS.map(key=>({key,label:TRAIT_LABELS[key],value:state[key],baseline:baseline[key]})),
      relationship:relationStateStore.getInjectionView(this.owner,Date.now()),tools:this.tools(),searchStats:stats,memoryCount:this.memories().length,growthCount:this.count('growth_event')};
  }
  routes(serialize:<T>(op:()=>T)=>Promise<T>) {
    const routes=new Hono();
    const digest=(()=>{try{const path=process.env.BRAIN_CONSOLE_KEY_FILE; const key=path && readFileSync(path,'utf8').trim();return key && /^[a-f0-9]{64}$/.test(key)?sha('Bearer '+key):null;}catch{return null;}})();
    routes.use('*',async (c,next)=>{
      c.header('Cache-Control','no-store');
      if (!digest || !timingSafeEqual(sha(c.req.header('authorization')??''),digest)) return c.json({error:'管理身份无效'},401);
      await next();
    });
    routes.use('*',bodyLimit({maxSize:8192}));
    routes.onError((e,c)=>e instanceof ConsoleError ? c.json({error:e.message},e.status) : c.json({error:'大脑后台暂时无法完成操作'},503));
    routes.get('/overview',c=>c.json(this.overview()));
    routes.get('/memories',c=>{
      const {offset,limit}=validate(page,c.req.query());
      const data=this.memories();return c.json({total:data.length,items:data.slice(offset,offset+limit).map(({itemId,...item})=>item)});
    });
    routes.post('/memories',async c=>{
      const {text}=validate(z.object({text:z.string().trim().min(1).max(180)}).strict(),await c.req.json().catch(()=>null));
      await serialize(()=>this.writeMemory(text));return c.json({ok:true});
    });
    routes.on(['PUT','DELETE'],'/memories/:id',async c=>{
      const expected=z.string().min(1).max(256);
      const body=await c.req.json().catch(()=>null);
      const edit=c.req.method==='PUT';
      const input=validate(z.object({expected,value:edit?z.string().trim().min(1).max(50):z.undefined()}).strict(),body);
      await serialize(()=>this.changeMemory(c.req.param('id')!,input.expected,input.value));return c.json({ok:true});
    });
    routes.get('/growth',c=>{
      const {limit,offset}=validate(page,c.req.query());
      return c.json({total:this.count('growth_event'),items:this.growthRows('ORDER BY e.ts DESC,e.rowid DESC LIMIT ? OFFSET ?',[limit,offset]).map(row=>{
        const reason=this.growthReason(row);
        const source=[row.example && '原回答：'+safe(row.example,60),row.quote && '原话：'+safe(row.quote,60)].filter(Boolean).join('　');
        return {id:row.id,at:row.at,module:row.module,dimension:safe(row.dimension),from:safe(row.from,60),to:safe(row.to,60),reason:safe(row.reason,160).replace(/家长/g,'主人').replace(/孩子/g,'主人'),rule:row.rule,source,revertible:!reason,revokeReason:reason};
      })});
    });
    routes.post('/growth/:id/revoke',async c=>{await serialize(()=>this.revoke(c.req.param('id')));return c.json({ok:true});});
    routes.put('/tools',async c=>{this.toolChange(validate(writeTools,await c.req.json().catch(()=>null)));return c.json({ok:true});});
    routes.put('/style',async c=>{
      const {style,previous}=validate(z.object({style:styles,previous:styles}).strict(),await c.req.json().catch(()=>null));
      if (previous!==this.style()) throw conflict();
      if (style!==previous) traitStore.setTemplate(this.owner,style,{source:'parent'});
      return c.json({ok:true});
    });
    routes.get('/tools/history',c=>{
      const {limit,offset}=validate(page,c.req.query());
      const items=this.searchlog.prepare(`SELECT id,at,tool,outcome,source_count AS sourceCount,turn_ms AS turnMs FROM personal_tool_result
        WHERE account_id=? AND at>=? ORDER BY at DESC,id DESC LIMIT ? OFFSET ?`).all(this.owner,Date.now()-7*86_400_000,limit,offset);
      return c.json({total:this.count('personal_tool_result'),items});
    });
    routes.get('/search',c=>{
      const {limit,offset}=validate(page,c.req.query());
      const items=this.searchlog.prepare(`SELECT id,created AS at,json_extract(body,'$.status') AS status,json_extract(body,'$.outcome') AS outcome,
        coalesce(json_array_length(body,'$.result.sources'),json_extract(body,'$.sourceCount')) AS sourceCount,json_extract(body,'$.readyAt')-created AS durationMs,
        json_extract(body,'$.failure.reason') AS failure FROM tasks WHERE subject=? AND session NOT GLOB 'admin-diagnostic-*' ORDER BY created DESC,id DESC LIMIT ? OFFSET ?`).all(this.owner,limit,offset);
      return c.json({total:this.count('tasks'),items});
    });
    routes.route('/',createConsoleActivity(this.dir,this.owner,(text)=>safe(text,8000)));
    return routes;
  }
}
