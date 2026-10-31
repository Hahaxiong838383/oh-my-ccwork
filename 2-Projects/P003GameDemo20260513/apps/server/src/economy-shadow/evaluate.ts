import {canonical,dayBounds,DAY_MS,ENGINE_VERSION,parseInput,parseRule,sha256,type Basis,type Observation,type ScenarioRule} from './contracts.js';
const integer=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x);
const symbol=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9_.:/@+\-]{1,128}$/.test(x);
const gm=(e:Observation)=>e.data.gm_override===true||e.data.source_mode==='gm'||[e.data.command,e.data.source_kind].some(x=>typeof x==='string'&&/(?:^|[^a-z0-9])(gm|debug|test)(?:$|[^a-z0-9])/i.test(x));

/** Mathematical candidate only: never a ledger, claim, or credit operation. */
export function calculateScenario(seconds:number,rule:ScenarioRule){
 if(!integer(seconds)||seconds<0||seconds>86400)throw new Error('invalid_seconds');
 const checked=parseRule(rule),stages=checked.stages.filter(s=>s.target_seconds<=seconds);
 const totals:Record<string,number>=Object.create(null);
 for(const s of stages)for(const r of s.rewards)totals[r.item_id]=(totals[r.item_id]??0)+r.quantity;
 return {stages:stages.map(s=>s.id),totals,next_target_seconds:checked.stages.find(s=>s.target_seconds>seconds)?.target_seconds??null};
}
function dedupe(rows:Observation[],issues:Set<string>){
 const byId=new Map<string,Map<string,Observation>>();
 for(const e of rows){let m=byId.get(e.id);if(!m)byId.set(e.id,m=new Map());m.set(canonical(e),e);}
 const retained:Observation[]=[],digestRows:string[]=[];
 for(const [id,m]of [...byId].sort(([a],[b])=>a<b?-1:a>b?1:0)){
  const values=[...m].sort(([a],[b])=>a<b?-1:a>b?1:0);digestRows.push(canonical({id,variants:values.map(([v])=>v)}));
  if(m.size!==1){issues.add('event_id_conflict');continue;}retained.push(values[0][1]);
 }
 return {rows:retained.sort((a,b)=>a.occurred_at_ms-b.occurred_at_ms||(a.id<b.id?-1:a.id>b.id?1:0)),hash:sha256(digestRows.join('\n')),unique:byId.size};
}
export function evaluateReplay(raw:unknown,ruleRaw:unknown=null,basis:Basis|null=null){
 const input=parseInput(raw),rule=ruleRaw===null?null:parseRule(ruleRaw),{start,end}=dayBounds(input.day),issues=new Set<string>();
 if(rule&&!['telemetry_union','checkpoint_max'].includes(basis??''))throw new Error('explicit_scenario_basis_required');
 if(input.truncated.analytics||input.truncated.telemetry)issues.add('source_truncated');
 const a=dedupe(input.analytics,issues),t=dedupe(input.telemetry,issues);
 // Contamination is a veto even when the marker itself has an unreliable clock.
 if([...input.analytics,...input.telemetry].some(gm))issues.add('gm_evidence');
 const valid=(e:Observation)=>{
  if(e.clock_suspicious||Math.abs(e.clock_skew_ms??0)>120000||e.occurred_at_ms>e.received_at_ms+2000||e.received_at_ms>input.cutoff_ms||e.occurred_at_ms>input.cutoff_ms+2000){issues.add('clock_or_cutoff_invalid');return false;}
  return true;
 };
 const analytics=a.rows.filter(e=>valid(e)&&e.occurred_at_ms>=start&&e.occurred_at_ms<end);
 const telemetry=t.rows.filter(valid);
 const versions=[...new Set(analytics.map(e=>e.version).filter((x):x is string=>x!==null))].sort();
 const revisions=[...new Set(analytics.flatMap(e=>[e.data.revision,e.data.config_revision]).filter(symbol))].sort();
 if(versions.length>1)issues.add('mixed_content_versions');
 if(revisions.length>1||analytics.some(e=>e.name==='g1.config_revision_changed'&&e.data.previous_revision!==e.data.revision))issues.add('rules_changed_in_window');
 const intervals:[number,number][]=[],checkpoints:{session:string|null;seconds:number;at:number}[]=[];
 for(const e of telemetry){if(e.name!=='focus_segment')continue;
  const s=e.data.start_ms,n=e.data.end_ms;
  if(!integer(s)||!integer(n)||s<=0||n<=s||n-s>DAY_MS||n>e.occurred_at_ms+2000||!symbol(e.data.focus_id)){issues.add('invalid_duration');continue;}
  const left=Math.max(start,s),right=Math.min(end,n,input.cutoff_ms);
  if(right>left)intervals.push([left,right]);
 }
 let union=0,sum=0,lastEnd=0;
 for(const [s,n]of intervals.sort((a,b)=>a[0]-b[0]||a[1]-b[1])){sum+=n-s;union+=Math.max(0,n-Math.max(s,lastEnd));lastEnd=Math.max(lastEnd,n);}
 const rewardById=new Map<string,string>();
 for(const e of analytics){
  if(typeof e.data.logical_day==='string'&&e.data.logical_day!==input.day){issues.add('logical_day_mismatch');continue;}
  if(e.name==='g1.progress_checkpoint'){
   const n=e.data.elapsed_seconds;
   if(!integer(n)||n<0||n>86400||e.data.logical_day!==input.day){issues.add('invalid_duration');continue;}
   checkpoints.push({session:e.session,seconds:n,at:e.occurred_at_ms});
  }
  if(e.name==='g1.reward_granted'){
   const id=e.data.reward_instance_id;
   if(!symbol(id)){issues.add('reward_identity_missing');continue;}
   const h=sha256(canonical(e.data));if(rewardById.has(id)&&rewardById.get(id)!==h)issues.add('reward_instance_conflict');
   rewardById.set(id,h);
  }
 }
 const sessions=new Set(checkpoints.map(c=>c.session));
 if(sessions.size>1||sessions.has(null))issues.add('checkpoint_multiple_sessions');
 const previous=new Map<string|null,{seconds:number;at:number}>();
 for(const c of checkpoints){const p=previous.get(c.session);if(p&&(c.seconds<p.seconds||c.at===p.at&&c.seconds!==p.seconds))issues.add('checkpoint_reversal');previous.set(c.session,c);}
 const observed={telemetry_segments:intervals.length,telemetry_union_ms:intervals.length?union:null,telemetry_overlap_ms:intervals.length?sum-union:null,checkpoint_count:checkpoints.length,checkpoint_max_seconds:checkpoints.length?Math.max(...checkpoints.map(c=>c.seconds)):null,checkpoint_sessions:sessions.size,reward_instances:rewardById.size};
 const blockers=['input_coverage_unproven','ownership_and_save_scope_unverified','effective_presence_unverified','current_rule_not_bound','event_rule_version_unverified'];
 if(checkpoints.length)blockers.push('checkpoint_domain_unverified');
 if(!intervals.length&&!checkpoints.length)blockers.push('no_duration_input');
 const seconds=basis==='telemetry_union'?(observed.telemetry_union_ms===null?null:Math.floor(observed.telemetry_union_ms/1000)):basis==='checkpoint_max'?observed.checkpoint_max_seconds:null;
 const scenario=rule&&seconds!==null&&issues.size===0?{purpose:'scenario_only' as const,basis,assumption:'仅假设观测时长全部有效且满足候选规则；未证明当前正式规则、使用日类型或领取条件。',seconds,rule_revision:rule.revision,rule_sha256:sha256(canonical(rule)),result:calculateScenario(seconds,rule)}:null;
 const digest=sha256(canonical({engine:ENGINE_VERSION,subject:input.subject,day:input.day,cutoff_ms:input.cutoff_ms,analytics:a.hash,telemetry:t.hash,truncated:input.truncated,rule,basis}));
 return {schema_version:1,engine_version:ENGINE_VERSION,run_id:digest,subject_alias:input.subject.slice(-8),scope_sha256:sha256(input.subject),day:input.day,cutoff_ms:input.cutoff_ms,mode:'shadow_only' as const,ready_for_settlement:false as const,certified_eligible_ms:null,quality:'unknown' as const,comparison_status:'not_comparable' as const,source_counts:{analytics:a.unique,telemetry:t.unique},input_sha256:sha256(canonical({analytics:a.hash,telemetry:t.hash})),truncated:input.truncated,content_version_basis:'upload_batch_declaration' as const,content_versions:versions,config_revisions:revisions,observed,issues:[...issues].sort(),blockers:[...blockers,...issues].sort(),scenario,rule_candidate:rule?{revision:rule.revision,sha256:sha256(canonical(rule)),source_sha256:rule.source_sha256,purpose:rule.purpose}:null};
}
export type ShadowReport=ReturnType<typeof evaluateReplay>;
