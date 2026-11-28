import type {DatabaseSync} from 'node:sqlite';

type Fact = {id:string;topic:string;value:string;sourceId?:string};
type Message = {id:string;role:string;text:string;at:number;session:string};
type Source = {title:string;url:string};

export function publicSources(sources:readonly Source[]|undefined,redact:(value:unknown,max:number)=>string) {
  return (sources??[]).slice(0,12).flatMap(source=>{
    try {
      const url=new URL(source.url);
      if (!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.length>2048) return [];
      // Provider URLs can contain signed tokens. Do not persist opaque, sensitive or access-bearing links.
      if ([...url.searchParams.keys()].some(k=>/token|apikey|api_key|sign|credential|password|secret|auth|^key$/i.test(k))) return [];
      url.hash='';
      return [{title:redact(source.title,180),url:url.href}];
    } catch {return [];}
  });
}

export function readWhitebox(db:DatabaseSync,search:DatabaseSync,owner:string,room:string,offset:number,limit:number,
  facts:readonly Fact[],redact:(value:unknown,max:number)=>string) {
  const total=Number(db.prepare("SELECT count(*) AS n FROM transcripts.conversation WHERE account_id=? AND session_id=? AND role='assistant'").get(owner,room)!.n);
  if (!total) return null;
  const replies=db.prepare(`SELECT c.id,c.ts,r.user_id,
    CASE WHEN r.voice_turn IS NOT NULL AND NOT EXISTS (SELECT 1 FROM personal_turn_trace other
      WHERE other.account_id=r.account_id AND other.session_id=r.session_id AND other.voice_turn=r.voice_turn AND other.reply_id<>r.reply_id)
    THEN r.voice_turn END AS voice_turn,r.route,r.style,m.mode,m.memory_ids
    FROM transcripts.conversation c
    LEFT JOIN personal_turn_trace r ON r.reply_id=c.id AND r.session_id=c.session_id AND r.account_id=c.account_id
    LEFT JOIN personal_turn_recall m ON m.reply_msg_id=c.id AND m.account_id=c.account_id
    WHERE c.account_id=? AND c.session_id=? AND c.role='assistant'
    ORDER BY c.ts DESC,c.rowid DESC LIMIT ? OFFSET ?`).all(owner,room,limit,offset);

  const findSource=db.prepare(`SELECT c.id,c.role,c.session_id AS session,c.ts AS at,
    CASE WHEN r.msg_id IS NOT NULL OR c.ts<=COALESCE(b.cut,0) THEN '（原话已按记忆边界隐藏）' ELSE c.text END AS text
    FROM transcripts.conversation c LEFT JOIN personal_whitebox_retired r ON r.account_id=c.account_id AND r.msg_id=c.id
    LEFT JOIN personal_legacy_boundary b ON b.account_id=c.account_id WHERE c.account_id=? AND c.id=?`);
  const cache=new Map<string,Message|null>();
  function message(id:unknown) {
    if (typeof id!=='string' || !id) return null;
    if (!cache.has(id)) {
      const row=findSource.get(owner,id);
      cache.set(id,row?{id,role:String(row.role),text:redact(row.text,8000),at:Number(row.at),session:String(row.session)}:null);
    }
    return cache.get(id)!;
  }

  const byId=new Map(facts.map(f=>[f.id,f]));
  const factView=(f:Fact)=>({id:f.id,topic:f.topic,value:f.value,source:message(f.sourceId)});
  const toolFor=search.prepare(`SELECT id,at,tool,outcome,source_count AS sourceCount,turn_ms AS turnMs,sources_json
    FROM personal_tool_result WHERE account_id=? AND session_id=? AND reply_id=? AND at>=? LIMIT 1`);
  const retentionStart=Date.now()-7*86400000;
  const growthFor=db.prepare(`SELECT e.id,e.ts AS at,e.module,e.dimension,e.from_val AS 'from',e.to_val AS 'to',
    e.rule,e.reply_msg_id,e.feedback_msg_id,r.ts AS revokedAt FROM growth_event e
    LEFT JOIN personal_growth_revoke r ON e.account_id=r.account_id AND e.id=r.event_id
    WHERE e.account_id=? AND (e.reply_msg_id=? OR e.feedback_msg_id=?) ORDER BY e.ts,e.rowid`);
  const turns=replies.map((row,index)=>{
    const reply=message(row.id)!;
    const source=message(row.user_id);
    // Old records lack exact pairing. Preserve their reply without guessing its preceding input.
    const user=source?.session===room && source.role==='user'?source:null;
    const toolRow=toolFor.get(owner,room,reply.id,retentionStart);
    const tool=toolRow?{id:toolRow.id,at:toolRow.at,tool:toolRow.tool,outcome:toolRow.outcome,
      sourceCount:toolRow.sourceCount,turnMs:toolRow.turnMs,sources:JSON.parse(String(toolRow.sources_json??'[]')) as Source[]}:null;
    const events=growthFor.all(owner,reply.id,user?.id??'').flatMap(e=>{
      const target=message(e.reply_msg_id),feedback=message(e.feedback_msg_id);
      if (!target || !feedback || target.session!==room || feedback.session!==room || target.role!=='assistant' || feedback.role!=='user') return [];
      return [{id:e.id,at:e.at,module:e.module,dimension:redact(e.dimension,100),from:redact(e.from,100),
        to:redact(e.to,100),rule:e.rule,revokedAt:e.revokedAt,reply:target,feedback}];
    });
    const selected=JSON.parse(String(row.memory_ids??'[]')) as string[];
    const recall=row.mode?{mode:row.mode,items:selected.map(id=>{
      const f=byId.get(id);
      return f?factView(f):{id:null,topic:'旧版本',value:'',source:null};
    })}:null;
    return {ordinal:total-offset-index,reply,user,route:row.route,voiceTurn:row.voice_turn,style:row.style,
      recall,memories:user?facts.filter(f=>f.sourceId===user.id).map(factView):[],
      growth:events.filter(e=>e.feedback.id===user?.id),
      attributedGrowth:events.filter(e=>e.reply.id===reply.id),tool};
  }).reverse();
  return {room,total,offset,turns};
}
