import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {createConsoleActivity} from './console-activity.js';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import {PersonalMemoryActions, parseMemoryCommand} from './memory-actions.js';
import {PersonalRecall,evidenceId} from './memory-recall.js';
import {TRAIT_DIMS, TRAIT_LABELS, traitStore} from './p003/trait-store.js';
import {memoryItemStore} from './p003/memory-item-store.js';
import {extractionTarget} from './providers.js';
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
const memoryFields = z.object({kind:z.enum(['fact','preference','name']),topic:z.string().trim().min(1).max(50),value:z.string().trim().min(1).max(50)}).strict();
type MemoryFields = z.infer<typeof memoryFields>;
type State = 'verified'|'pending'|'inactive';
type MemoryRow = {id:string;kind:string;topic:string;value:string;source:string;updatedAt:number|null;manageable:boolean;editable:boolean;state:State;canApprove:boolean;canResolve:boolean;itemId?:string;sourceId?:string;disposition?:string;proposed?:MemoryFields;conflict?:MemoryFields & {id:string}};
type GrowthRow = {id:string;at:number;module:string;dimension:string;from:string;to:string;reason:string;rule:string;quote:string;replyId:string|null;feedbackId:string|null;example:string|null;question:string|null;revokedAt:number|null;rowNumber:number};

export class OwnerConsole {
  private readonly db: DatabaseSync;
  private readonly searchlog: DatabaseSync;
  private lastSnapshot='';
  constructor(private readonly dir:string, private readonly owner:string, private readonly memory:PersonalMemoryActions, private readonly recall:PersonalRecall) {
    this.db=new DatabaseSync(join(dir,'profile.sqlite'));
    this.db.exec('PRAGMA busy_timeout=3000');
    this.db.prepare('ATTACH DATABASE ? AS transcripts').run(join(dir,'conversations.sqlite'));
    this.searchlog = new DatabaseSync(join(dir,'search.sqlite'));
    this.searchlog.exec(`PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS personal_tool_result(id INTEGER PRIMARY KEY,account_id TEXT NOT NULL,at INTEGER NOT NULL,
      tool TEXT NOT NULL,outcome TEXT NOT NULL,source_count INTEGER,turn_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS personal_tool_at ON personal_tool_result(account_id,at DESC,id DESC)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS personal_tool_settings(account_id TEXT PRIMARY KEY, search INTEGER NOT NULL, weather INTEGER NOT NULL, clock INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_growth_revoke(account_id TEXT NOT NULL,event_id TEXT NOT NULL,ts INTEGER NOT NULL, PRIMARY KEY(account_id,event_id))`);
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('trait_snapshot') WHERE name='personal_relation'").get()) {
      this.db.exec("ALTER TABLE trait_snapshot ADD COLUMN personal_relation TEXT");
    }
    this.sampleDailyState();setInterval(()=>this.sampleDailyState(),60_000).unref();
  }
  private sampleDailyState() {
    // Persist one observation per local day, updating it only after the measured state changes.
    try {
      const now=Date.now(),day=new Date(now+8*3600000).toISOString().slice(0,10);
      const live=relationStateStore.getInjectionView(this.owner,now);
      const relation=live?{tier:live.tier,sessionCount:live.sessionCount,daysKnown:live.daysKnown,mood:live.mood}:null;
      const current=traitStore.get(this.owner), traits=Object.fromEntries(TRAIT_DIMS.map(key=>[key,current[key]]));
      const template=this.style(),signature=JSON.stringify([day,traits,template,relation]);
      if (signature===this.lastSnapshot) return;
      this.db.prepare(`INSERT INTO trait_snapshot(account_id,day,state,template,created_at,personal_relation) VALUES(?,?,?,?,?,?)
        ON CONFLICT(account_id,day) DO UPDATE SET state=excluded.state,template=excluded.template,created_at=excluded.created_at,
        personal_relation=excluded.personal_relation`).run(this.owner,day,JSON.stringify(traits),template,now,JSON.stringify(relation));
      this.lastSnapshot=signature;
    } catch {console.warn('private_trait_snapshot_unavailable');}
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
  private memories(includeInactive=false):MemoryRow[] {
    const entries=this.recall.evidence(this.owner);
    const rows:MemoryRow[]=[];
    const verifiedIds=new Set<string>();
    for (const e of entries) {
      if (e.id) verifiedIds.add(e.id);
      const editable=['fact','name','preference'].includes(e.kind) && safe(e.value)===e.value && safe(e.topic)===e.topic;
      rows.push({id:evidenceId(e),state:'verified',canApprove:false,canResolve:!!e.id && ['promise','assistant-promise'].includes(e.kind),sourceId:e.sourceMsgId,
        kind:e.kind,topic:safe(e.topic),value:safe(e.value),source:safe(e.quote),updatedAt:e.updatedAt??null,
        manageable:editable||!!e.id,editable,itemId:e.id});
    }
    const knownTopics = new Set(entries.map(row=>JSON.stringify([row.kind,row.topic])));
    const saved = this.db.prepare('SELECT kind,topic,value,updated_at,source_msg_id FROM personal_memory_fact WHERE account_id=?').all(this.owner);
    for (const row of saved) {
      const kind=String(row.kind), topic=String(row.topic), value=String(row.value);
      if (knownTopics.has(JSON.stringify([kind,topic]))) continue;
      const editable=['fact','name','preference'].includes(kind) && safe(topic)===topic && safe(value)===value;
      rows.push({id:sha(JSON.stringify(['unverified',kind,topic,value,row.updated_at])).toString('hex'),
        kind,topic:safe(topic),value:safe(value),source:'未找到可核验的主人原话',updatedAt:Number(row.updated_at),
        manageable:editable,editable,state:'pending',canApprove:editable,canResolve:false,sourceId:String(row.source_msg_id)});
    }
    // Keep old unverified items inspectable without treating them as evidence in a reply.
    const others=this.db.prepare(`SELECT m.id,m.type,m.content,m.status,m.source_msg_id,m.created_at,c.role,c.text AS original,c.ts AS sourceAt
      FROM memory_item m LEFT JOIN transcripts.conversation c ON c.id=m.source_msg_id AND c.account_id=m.account_id
      WHERE m.account_id=? AND m.source!='personal-owner' ${includeInactive?'':"AND m.status='active'"} ORDER BY m.created_at DESC,m.rowid DESC`).all(this.owner);
    for (const r of others) {
      const id=String(r.id);
      if (verifiedIds.has(id)) continue;
      const active=r.status==='active',disposition=String(r.status);
      // Only expose an adjudication when the owner's exact, unqualified statement and the extractor agree.
      const quote=String(r.original??'').trim().replace(/[。！!]$/u,'');
      const pref=active && r.role==='user' && r.type==='preference' && /^我(不喜欢|喜欢)([\p{L}\p{N}]{1,24})$/u.exec(quote);
      const proposed:MemoryFields|undefined=pref && !/今天|这次|这回|有时|偶尔|暂时|最近|这几天|如果|假如|以前|过去/u.test(quote)
        && ['我'+pref[1]+pref[2],pref[1]+pref[2]].includes(String(r.content)) && safe(quote)===quote ?
        {kind:'preference',topic:pref[2],value:pref[1]}:undefined;
      const peer=proposed && rows.find(x=>x.state==='verified' && x.kind==='preference' && x.topic===proposed.topic
        && x.value!==proposed.value && x.updatedAt!==null && Number(r.sourceAt)>x.updatedAt);
      const conflict=peer?{id:peer.id,kind:'preference' as const,topic:peer.topic,value:peer.value}:undefined;
      rows.push({id:sha('item:'+id).toString('hex'),kind:String(r.type),topic:active?'待核验条目':'历史条目',value:safe(r.content),
        source:active?'未达到语音召回的证据要求':'已从在用记忆移出',updatedAt:Number(r.created_at),manageable:active,
        editable:false,itemId:id,sourceId:String(r.source_msg_id??''),state:active?'pending':'inactive',disposition,
        proposed,conflict,canApprove:active && safe(r.content)===r.content,canResolve:active && r.type==='promise'});
    }
    return rows.sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)||a.id.localeCompare(b.id));
  }
  private writeMemory(text:string, expected?:Pick<MemoryRow,'kind'|'topic'|'value'>,reviewItemId?:string) {
    const parsed=parseMemoryCommand(text);
    if (!parsed || parsed.op!=='set' || secret.test(text) || isCrisisContent(text))
      throw new ConsoleError(400,'请写明要记住的称呼、偏好或事实');
    if (expected && (parsed.facts.length!==1 || parsed.facts[0].kind!==expected.kind || parsed.facts[0].topic!==expected.topic || parsed.facts[0].value!==expected.value)) throw new ConsoleError(400,'新内容与所选记忆不匹配');
    try {this.memory.apply(parsed,'owner-console',text,reviewItemId);}
    catch(e){if(e instanceof Error && e.message==='review_item_changed') throw conflict();throw e;}
  }
  private changeMemory(id:string,expected:string,value?:string) {
    const r=this.memories().find(row=>row.id===id);
    if (!r) throw missing();
    if (r.value!==expected) throw conflict();
    if (!r.manageable || (value!==undefined && !r.editable)) throw new ConsoleError(400,'此类记忆不能这样修改');
    if (value!==undefined) {
      const phrase=r.kind==='name'?'以后叫我'+value:r.kind==='preference'?'我'+value+r.topic:'我的'+r.topic+'是'+value;
      if (r.kind==='preference' && !['喜欢','不喜欢'].includes(value)) throw new ConsoleError(400,'偏好只能设为喜欢或不喜欢');
      this.writeMemory('记住，'+phrase,{...r,value});
    } else {
      const kind=r.kind==='name'||r.kind==='preference'||r.kind==='fact'?r.kind:undefined;
      this.memory.apply({op:'forget',target:{topic:r.topic,kind,itemId:r.editable?undefined:r.itemId}},
        'owner-console','在私人后台忘记所选的一条记忆');
    }
  }
  private structured(input:MemoryFields,reviewItemId?:string) {
    const {kind,topic,value}=input;
    if (kind==='preference' && !['喜欢','不喜欢'].includes(value)) throw new ConsoleError(400,'偏好请选择喜欢或不喜欢');
    if(kind==='name' && topic!=='称呼') throw new ConsoleError(400,'称呼的主题须为称呼');
    const phrase=kind==='name'?'以后叫我'+value:kind==='preference'?'我'+value+topic:'我的'+topic+'是'+value;
    this.writeMemory('记住，'+phrase,input,reviewItemId);
  }
  private publicMemory(row:MemoryRow) {
    const {itemId,sourceId,...view}=row;
    return {...view,conflict:row.conflict??null,proposed:row.proposed??null};
  }
  private sourceTurn(id:string|undefined) {
    if(!id) return null;
    const turn=this.db.prepare('SELECT id,role,text,ts AS at,session_id AS session FROM transcripts.conversation WHERE account_id=? AND id=?').get(this.owner,id);
    return turn?{...turn,text:safe(turn.text,1500)}:null;
  }
  private usage() {
    const rows=this.db.prepare(`SELECT j.value AS id,count(*) AS usageCount,max(c.ts) AS lastUsedAt FROM personal_turn_recall r
      JOIN transcripts.conversation c ON r.account_id=c.account_id AND r.reply_msg_id=c.id,json_each(r.memory_ids) j
      WHERE r.account_id=? AND c.role='assistant' GROUP BY j.value`).all(this.owner);
    return new Map(rows.map(r=>[String(r.id),{usageCount:Number(r.usageCount),lastUsedAt:Number(r.lastUsedAt)}]));
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
  routes(serialize:<T>(op:()=>T)=>Promise<T>,pendingExtractions:()=>number|null=()=>null) {
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
      const {offset,limit,q,kind,state}=validate(page.extend({q:z.string().trim().max(120).optional(),kind:z.string().trim().max(50).optional(),
        state:z.enum(['verified','pending','inactive','conflict']).optional()}).strict(),c.req.query());
      const records=this.memories(true), counts={verified:0,pending:0,inactive:0,conflicts:0};
      for(const r of records){counts[r.state]++;if(r.conflict) counts.conflicts++;}
      const term=q?.toLocaleLowerCase();
      const data=records.filter(r=>(state==='conflict'?!!r.conflict:state?r.state===state:r.state!=='inactive') && (!kind||kind===r.kind)
        && (!term||[r.topic,r.value,r.source].some(v=>v.toLocaleLowerCase().includes(term))));
      const usage=this.usage();
      return c.json({total:data.length,counts,kinds:[...new Set(records.map(r=>r.kind))].sort(),items:data.slice(offset,offset+limit)
        .map(r=>({...this.publicMemory(r),...(usage.get(r.id)??{lastUsedAt:null,usageCount:0})}))});
    });
    routes.get('/memories/:id',c=>{
      const item=this.memories(true).find(r=>r.id===c.req.param('id'));if(!item) throw missing();
      const receiptJoin="FROM personal_turn_recall r JOIN transcripts.conversation c ON r.account_id=c.account_id AND r.reply_msg_id=c.id WHERE r.account_id=? AND c.role='assistant'";
      const uses=this.db.prepare('SELECT c.id,c.session_id AS session,c.ts AS at '+receiptJoin+
        ' AND EXISTS (SELECT 1 FROM json_each(r.memory_ids) j WHERE j.value=?) ORDER BY c.ts DESC LIMIT 50').all(this.owner,item.id);
      const count=this.usage().get(item.id)??{usageCount:0,lastUsedAt:null};
      const since=this.db.prepare('SELECT min(c.ts) AS at '+receiptJoin).get(this.owner);
      return c.json({item:{...this.publicMemory(item),...count},sourceTurn:this.sourceTurn(item.sourceId),uses,usageSince:since?.at??null});
    });
    routes.get('/turns/:id/memories',c=>{
      const turn=this.db.prepare("SELECT c.ts AS at,r.mode,r.memory_ids FROM transcripts.conversation c LEFT JOIN personal_turn_recall r ON c.account_id=r.account_id AND c.id=r.reply_msg_id WHERE c.account_id=? AND c.role='assistant' AND c.id=?").get(this.owner,c.req.param('id'));
      if(!turn) throw missing();
      const ids:string[]=turn.memory_ids ? JSON.parse(String(turn.memory_ids)) : [];
      const current=new Map((ids.length?this.memories():[]).map(r=>[r.id,r]));
      return c.json({state:turn.mode??'unknown',at:turn.at,items:ids.map(id=>{
        const r=current.get(id);return r?{id:r.id,topic:r.topic,value:r.value,reason:turn.mode==='model'?'本轮选入模型输入':'本轮据证回答'}:
          {id:null,topic:'旧版本',value:'',reason:'本次使用的版本已更正或失效'};
      })});
    });
    routes.get('/extractions',c=>{
      const {offset,limit}=validate(page,c.req.query());
      const stat=this.db.prepare(`SELECT count(*) AS runs,count(*) FILTER(WHERE ok=0) AS failed,
        coalesce(sum(candidates),0) AS candidates,coalesce(sum(added),0) AS added FROM extraction_log WHERE account_id=?`).get(this.owner)!;
      const target=extractionTarget();
      const latest=this.db.prepare('SELECT ts AS at,ok FROM extraction_log WHERE account_id=? ORDER BY ts DESC,rowid DESC LIMIT 1').get(this.owner);
      const failure=this.db.prepare('SELECT ts AS at,note,rejected FROM extraction_log WHERE account_id=? AND ok=0 ORDER BY ts DESC,rowid DESC LIMIT 1').get(this.owner);
      const service={configured:!!(target.apiKey && target.baseUrl && target.model),provider:target.provider,pending:pendingExtractions(),
        lastAt:latest?.at??null,lastOk:latest?!!latest.ok:null,lastFailure:failure?{at:failure.at,reason:safe(failure.note||failure.rejected,300)||'未记录具体原因'}:null};
      const rows=this.db.prepare(`SELECT id,ts AS at,ok,llm_ms AS llmMs,candidates,added,rejected,note,source_msg_id FROM extraction_log
        WHERE account_id=? ORDER BY ts DESC,rowid DESC LIMIT ? OFFSET ?`).all(this.owner,limit,offset);
      return c.json({total:Number(stat.runs),service,summary:stat,items:rows.map(({source_msg_id,ok,rejected,note,...r})=>({...r,ok:!!ok,
        rejected:safe(rejected,300),note:safe(note),sourceTurn:this.sourceTurn(String(source_msg_id??''))}))});
    });
    routes.get('/growth/snapshots',c=>{
      const relation=new Map(this.db.prepare('SELECT day,personal_relation FROM trait_snapshot WHERE account_id=? ORDER BY day DESC LIMIT 30').all(this.owner).map(r=>[r.day,r.personal_relation]));
      return c.json({dimensions:TRAIT_DIMS.map(key=>({key,label:TRAIT_LABELS[key]})),items:traitStore.listSnapshots(this.owner,30)
        .map(s=>({day:s.day,template:s.template||'default',traits:s.dims,at:s.created_at,relation:JSON.parse(String(relation.get(s.day)??'null'))}))});
    });
    routes.post('/memory-preview',async c=>{
      const {text}=validate(z.object({text:z.string().trim().min(1).max(300)}).strict(),await c.req.json().catch(()=>null));
      const result=this.recall.chatPrompt('私人记忆预览',{accountId:this.owner,role:'device'},text,'',true);
      const records=new Map(this.memories().map(r=>[r.id,r]));
      const items=result.memoryIds.flatMap(id=>{
        const r=records.get(id);return r?[{id,topic:r.topic,value:r.value,reason:'按当前规则与此问题匹配'}]:[];
      });
      return c.json({items,state:'preview'});
    });
    routes.post('/memories',async c=>{
      const input=validate(z.union([z.object({text:z.string().trim().min(1).max(180)}).strict(),memoryFields]),await c.req.json().catch(()=>null));
      await serialize(()=> 'text' in input?this.writeMemory(input.text):this.structured(input));return c.json({ok:true});
    });
    routes.post('/memories/:id/review',async c=>{
      const expected=z.string().min(1).max(256);
      const expectedPeer=z.string().regex(/^[a-f0-9]{64}$/).nullable().optional();
      const input=validate(z.union([memoryFields.extend({action:z.literal('approve'),expected,expectedPeer}).strict(),
        z.object({action:z.enum(['ignore','resolve']),expected,expectedPeer}).strict()]),await c.req.json().catch(()=>null));
      await serialize(()=>{
        const row=this.memories().find(r=>r.id===c.req.param('id'));
        if(!row || row.value!==input.expected || (input.expectedPeer??null)!==(row.conflict?.id??null)) throw conflict();
        if(input.action==='approve' && row.canApprove) {
          if (row.conflict && (input.kind!==row.conflict.kind || input.topic!==row.conflict.topic)) throw new ConsoleError(400,'校准的内容须对应同一主题');
          if (!row.itemId && (row.kind!==input.kind||row.topic!==input.topic)) throw new ConsoleError(400,'无法将既有记录改为其他主题');
          this.structured(input,row.itemId);
        } else if(input.action==='resolve' && row.canResolve && row.itemId) {
          if(!memoryItemStore.resolvePromisesByIds(this.owner,[row.itemId],'主人在私人后台确认兑现'))throw conflict();
        } else if(input.action==='ignore' && row.state==='pending') {
          if(!row.itemId) this.changeMemory(row.id,row.value);
          else if(!this.db.prepare("UPDATE memory_item SET status='retracted', valid_to=?,superseded_by='owner-ignored' WHERE account_id=? AND id=? AND status='active'").run(Date.now(),this.owner,row.itemId).changes) throw conflict();
        } else throw new ConsoleError(400,'这条记忆不支持此操作');
      });return c.json({ok:true});
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
