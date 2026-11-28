import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {isCrisisContent} from './p003/memory-safety-filter.js';

type Fact = {kind:'name'|'preference'|'fact'; topic:string; value:string; quote:string};
type Target = {topic:string; kind?:Fact['kind']; itemId?:string};
export type MemoryCommand = {op:'set'; facts:Fact[]} | {op:'forget'; target:Target} | {op:'clarify'; text:string};
type RecallVersion = {version:string; rawId?:string; sourceId?:string; kind:string; topic:string};
type Chat = {role:'user'|'assistant'; content:string};
const clarify = (text:string): MemoryCommand => ({op:'clarify', text});
const clean = (s:string) => s.trim().replace(/[。．.!！]+$/u,'').trim();
const nameTopic = /^(?:昵称|名字|称呼|怎么称呼我|叫什么名字)$/u;
const privateValue = /(?:密钥|口令|密码|银行卡|身份证|API\s*key|access.token)|[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu;
const quoted = /[「」『』“”"‘’]|(?:如果|要是|假设|假如|举个例子|打个比方|他(?:曾经)?说|她(?:曾经)?说|我没(?:有)?说过|我没有让你|我没让你|并非要你|不要记住|别记住|不要忘|别忘|请问|是否|能否|还记得|记不记得|有没有说过|忘了吗|忘了没|[?？]|[吗么][。！!\s]*$)/u;
const keyOK = (v:string, max=30) => v.length>0 && v.length<=max &&
  !/[，,。；;？?！!：:、\n<>\[\]{}/\\]/u.test(v) && !/^(?:什么|这个|那个|它|他|她|全部|所有|一切|这些|这件事|那件事|这条|那条)$/u.test(v);
const directFact = (kind:Fact['kind'],topic:string,value:string,quote:string) =>
  ({kind,topic,value,quote} satisfies Fact);

function preference(text:string): {topic:string; value:string}|undefined {
  const m=/^(?:我)?(?:其实|还是|已经|又|重新|开始|最)?(不喜欢|不爱吃|不吃|喜欢上|喜欢|爱吃)(?:吃)?(.+?)了?$/u.exec(text);
  if (!m) return;
  const topic=m[2];
  if (!keyOK(topic) || /(?:但是|不过|其实|原先|以前|后来|现在|你说|还是说|的话|以及|或者|还是|还有|应该|可能|好像)/u.test(topic)) return;
  return {topic, value:m[1].startsWith('不')?'不喜欢':'喜欢'};
}

function setClause(clause:string, explicit:boolean): Fact|undefined {
  const s=clause.trim().replace(/^(?:但(?:是)?|不过)?(?:我)?(?:其实|现在|以后|从今以后)?(?:请)?/u,'');
  let m=/^(?:叫我|称呼我(?:为)?)(.+)$/u.exec(s);
  if (!m && explicit) m=/^(?:我叫|名字叫|名字是|昵称是|昵称叫)(.+)$/u.exec(clause.replace(/^我的/u,''));
  if (m && keyOK(m[1],18)) return directFact('name','称呼',m[1],clause);
  const pref=preference(s);
  if (pref) return directFact('preference',pref.topic,pref.value,clause);
  m=/^(?:请)?(?:把|将)?我(?:的)([\p{L}\p{N}]{1,16}?)(改为|改成|改叫|换成|其实是|现在是|就是|是|叫)(.+)$/u.exec(clause);
  if (m && (explicit || /改|换|其实是|现在是/u.test(m[2]) || /^(?:暗号|昵称|生日|出生日期|居住地|性别)$/u.test(m[1])) && keyOK(m[3],50)) {
    const topic=m[1],value=m[3];
    if (nameTopic.test(topic)) return directFact('name','称呼',value,clause);
    return directFact('fact',topic,value,clause);
  }
  if (explicit && (m=/^我(?:现在)?住在(.+)$/u.exec(clause)) && keyOK(m[1])) return directFact('fact','居住地',m[1],clause);
}

/** Parse only an affirmative personal instruction. A question or quoted example cannot change memory. */
export function parseMemoryCommand(input:string): MemoryCommand|undefined {
  const t=clean(input.normalize('NFKC')).replace(/^(?:小可[,，、\s]*)?/u,'');
  if (!t || t.length>250) return;
  if (/^(?:请(?:你)?|麻烦你)?(?:这句(?:话)?|这件事)?(?:请)?(?:不要|别|不用)(?:再)?(?:保存|记住|记下|记录|记着|记这|记我)/u.test(t))
    return clarify('好，这句话不会写进长期记忆。');
  if (quoted.test(t)) {
    if (/^(?:请(?:你)?)?(?:记住|记下|更正|纠正)/u.test(t))
      return clarify('这句话里有假设、引用或疑问，我没有把它记成你的事实。');
    return;
  }
  const f=/^(?:请(?:你)?|麻烦你|帮我|你)?\s*(?:忘掉|忘了|忘记|别再记着|删除(?:关于)?|清除(?:关于)?)\s*(.+)$/u.exec(t)
    ?? /^(?:请(?:你)?|麻烦你|帮我|你)?\s*把(.+?)(?:给)?(?:忘掉|忘了|忘记|删掉|删除|清除)(?:吧|一下)?$/u.exec(t);
  if (f) {
    const clause=f[1].split(/[,，;；。]|(?:我希望|以后)?(?:以后)?不再保存|以后别再记/u)[0].trim().replace(/(?:吧|呗)$/u,'');
    const kind:Target['kind']=/口味|忌口|喜好|偏好|(?:不喜欢|不爱吃|不吃|喜欢吃)/u.test(clause)?'preference':undefined;
    let topic=clause.replace(/^(?:关于我的|我关于|关于我|关于|我对|我(?:的)?)/u,'')
      .replace(/^(?:以前|之前|曾经)?(?:不喜欢吃|喜欢吃|不喜欢|不爱吃|不吃|喜欢|爱吃)/u,'')
      .replace(/(?:的)?(?:有关|相关)?(?:的)?(?:那条|这条|那个|这个|那段|这段)?(?:口味|忌口|喜好|偏好|个人)?(?:记录|记忆|事情|这件事|那件事|偏好)$/u,'')
      .replace(/(?:这件事|那件事|这个事|的事)$/u,'').trim();
    if (/^(?:你给我的|我的|以前的|之前的)/u.test(topic)) topic=topic.replace(/^(?:你给我的|我的|以前的|之前的)/u,'');
    if (nameTopic.test(topic)) return {op:'forget',target:{topic:'称呼',kind:'name'}};
    if (!keyOK(topic) || (topic.length<2 && !kind) || /所有|全部|每件事|一切/u.test(topic))
      return clarify('你想让我忘掉哪一件事？说出具体的称呼、偏好或记忆内容就好。');
    return {op:'forget', target:{topic,kind}};
  }
  const prefix=/^(?:请(?:你)?|麻烦你|帮我)?(?:记住|记一下|记下|记着|更正(?:一下)?|纠正(?:一下)?|纠正记录|改正(?:一下)?)[,，:：、\s]*/u.exec(t);
  if (isCrisisContent(t) || privateValue.test(t))
    return prefix?clarify('这条内容不会保存为长期记忆。'):undefined;
  const body=(prefix?t.slice(prefix[0].length):t)
    .replace(/^(?:我(?:的)?(?:口味|喜好|偏好|口味偏好)(?:变了|改变了|有变化了)|我改主意了|我改口了|我之前说错了)[,，。:：\s]*/u,'');
  const correction=body.replace(/[,，。;；\s]*(?:请|麻烦)?(?:你)?(?:把|将)我(?:的)?(?:口味|喜好|偏好)(?:记对|改过来|改一下|更新一下|改一下记录|纠正一下)(?:吧)?$/u,'').replace(/[,，。;；\s]*(?:从今往后|今后|以后|往后)(?:可以|也可以|请|就)?(?:再)?(?:给我推荐|推荐给我|推荐)(?:它|了|吧)?$/u,'');
  const fieldChange=/^(?:请)?(?:把|将)?(?:我的)([\p{L}\p{N}]{1,16}?)(?:原来是|以前是|不是|从)([^,，。;；]+?)[,，。;；\s]*(?:现在是|改为|改成|换成|而是|是)(.+)$/u.exec(body);
  if (fieldChange && keyOK(fieldChange[3],50)) {
    const topic=fieldChange[1], value=fieldChange[3];
    return {op:'set',facts:[directFact(nameTopic.test(topic)?'name':'fact',nameTopic.test(topic)?'称呼':topic,value,input.trim())]};
  }
  const swap=/^(?:我)?(?:以前|之前|原来|过去|原本)([^,，。;；]+?)[,，。;；\s]*(?:但(?:是)?|不过)?(?:我)?(?:现在|目前|如今)(.+)$/u.exec(correction);
  if (swap) {
    const before=preference(swap[1]);
    if (before) {
      const s=swap[2].replace(/^(?:已经|又|重新|开始)/u,'');
      const after=preference(s);
      const same=/^(不喜欢|不爱吃|不吃|喜欢|爱吃)(?:吃)?(?:它)?了?$/u.exec(s);
      const value=same?(same[1].startsWith('不')?'不喜欢':'喜欢'):after?.value;
      if (value && (same || after?.topic===before.topic))
        return {op:'set',facts:[directFact('preference',before.topic,value,input.trim())]};
    }
  }
  const clauses=body.split(/[,，;；。]|(?:并且|而且)(?=我)|(?<=.)(?=我(?:最)?(?:不喜欢|不爱吃|不吃|喜欢吃|爱吃)|以后(?:都)?(?:请)?(?:不要|别)(?:再)?(?:给我)?推荐)/u)
    .map(c=>c.trim()).filter(Boolean);
  const facts:Fact[]=[];
  for(const clause of clauses) {
    const previous=facts.at(-1);
    const recommendation=/^(?:以后(?:都)?)?(?:请)?(?:不要|别|不用)(?:再)?(?:给我)?推荐(.*)$/u.exec(clause);
    if (previous?.kind==='preference' && previous.value==='不喜欢' && recommendation) {
      const item=recommendation[1];
      if (!item || /^(?:了|给我|它|它了)$/u.test(item) || item===previous.topic ||
          /^(?:含有?|带有?|加了?).+(?:的)?(?:零食|菜品|食物|东西)$/u.test(item) && item.includes(previous.topic)) continue;
    }
    const fact=setClause(clause,!!prefix);
    if (!fact || (!prefix && fact.kind==='preference' && !/^(?:我)?(?:现在|又|重新|已经|最)/u.test(clause))) {
      return prefix?clarify('你想让我记住或改正哪件事？可以说“我的暗号是星灯”或“我现在喜欢香菜了”。'):undefined;
    }
    if (!input.includes(fact.quote)) fact.quote=input.trim();
    facts.push(fact);
  }
  if (facts.length && facts.length<=4) return {op:'set',facts};
  if (prefix) return clarify('请把要记住的称呼、偏好或事实说具体一点。');
}

type Interest = {value:string; [key:string]:unknown};
type Profile = {nickname:string; preferred_address:string; interests:string; recent_emotion:string; personality_notes:string;
  birthday:string;gender:string;age_years:number|null};
const factText = (f:Fact) => f.kind==='name'?'称呼你为'+f.value:f.kind==='preference'? f.value+f.topic : f.topic+'是'+f.value;

/** Single-owner private service. Daily persona stores are initialized before this adapter. */
export class PersonalMemoryActions {
  private db:DatabaseSync;
  private readonly owner:string;
  constructor(dataDir:string,owner:string,private readonly recallVersions?:()=>RecallVersion[]) {
    this.owner=owner;
    this.db=new DatabaseSync(join(dataDir,'profile.sqlite'));
    this.db.prepare('ATTACH DATABASE ? AS dialogs').run(join(dataDir,'conversations.sqlite'));
    this.db.exec(`CREATE TABLE IF NOT EXISTS personal_memory_fact(
        account_id TEXT NOT NULL,kind TEXT NOT NULL,topic TEXT NOT NULL,value TEXT NOT NULL,
        source_quote TEXT NOT NULL,source_msg_id TEXT NOT NULL,updated_at INTEGER NOT NULL,
        PRIMARY KEY(account_id,kind,topic));
      CREATE TABLE IF NOT EXISTS personal_memory_boundary(account_id TEXT PRIMARY KEY, cut INTEGER NOT NULL);`);
    // Before granular invalidation was introduced, a single cut suppressed all earlier context.
    // Capture the old boundary once: pre-upgrade erasures have no source-level audit trail.
    this.db.exec(`CREATE TABLE IF NOT EXISTS personal_legacy_boundary(account_id TEXT PRIMARY KEY, cut INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS personal_history_mask(account_id TEXT NOT NULL, msg_id TEXT NOT NULL,PRIMARY KEY(account_id,msg_id));
      CREATE TABLE IF NOT EXISTS personal_turn_recall(account_id TEXT NOT NULL, reply_msg_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('model','direct')),memory_ids TEXT NOT NULL, source_ids TEXT NOT NULL,
        PRIMARY KEY(account_id,reply_msg_id));`);
    this.db.prepare('INSERT OR IGNORE INTO personal_legacy_boundary VALUES(?,?)').run(owner,this.revision);
  }

  recordRecall(replyId:string, selection?:{memoryIds:string[];sourceIds:string[]}) {
    this.db.prepare('INSERT INTO personal_turn_recall(account_id,reply_msg_id,mode,memory_ids,source_ids) VALUES(?,?,?,?,?)')
      .run(this.owner,replyId,selection?'model':'direct',JSON.stringify(selection?.memoryIds??[]),JSON.stringify(selection?.sourceIds??[]));
  }

  get revision():number {
    return Number(this.db.prepare('SELECT cut FROM personal_memory_boundary WHERE account_id=?').get(this.owner)?.cut??0);
  }
  filterSnapshot<T extends {ts:number;id?:string}>(rows:T[]):T[] {
    const legacy=this.db.prepare('SELECT cut FROM personal_legacy_boundary WHERE account_id=?').get(this.owner)!;
    const hidden=this.db.prepare('SELECT 1 FROM personal_history_mask WHERE account_id=? AND msg_id=?');
    return rows.filter(row=>row.id ? row.ts>Number(legacy.cut) && !hidden.get(this.owner,row.id) : row.ts>this.revision);
  }
  replyHistory(room:string,workerHistory:Chat[]):Chat[] {
    if (!this.revision || !workerHistory.length) return workerHistory;
    // Resolve the worker's unversioned text against authoritative, still-eligible turns in this room.
    return this.db.prepare(`SELECT c.role,c.text AS content FROM dialogs.conversation c
      WHERE c.account_id=? AND c.session_id=? AND c.ts>(SELECT cut FROM personal_legacy_boundary WHERE account_id=c.account_id)
        AND NOT EXISTS(SELECT 1 FROM personal_history_mask h WHERE h.account_id=c.account_id AND h.msg_id=c.id)
      ORDER BY c.ts DESC,c.rowid DESC LIMIT ?`).all(this.owner,room,workerHistory.length).reverse() as unknown as Chat[];
  }
  private maskHistory(sourceIds:Set<string>,mentions:(text:string)=>boolean,versions:Map<string,Set<string>>) {
    // Keep raw transcripts viewable. Exclude the whole old exchange when a source, literal or
    // previously transmitted fact identifies it. This also catches paraphrased model replies.
    const turns=this.db.prepare(`SELECT c.id,c.session_id,c.role,c.text,t.source_ids,t.memory_ids
      FROM dialogs.conversation c LEFT JOIN personal_turn_recall t ON t.account_id=c.account_id AND t.reply_msg_id=c.id
      WHERE c.account_id=? ORDER BY c.session_id,c.rowid`).all(this.owner);
    const hide=this.db.prepare('INSERT OR IGNORE INTO personal_history_mask VALUES(?,?)');
    for (const [index,turn] of turns.entries()) {
      const used=turn.memory_ids?JSON.parse(String(turn.memory_ids)) as string[]:[];
      const sources=turn.source_ids?JSON.parse(String(turn.source_ids)) as string[]:[];
      const linked=sources.some((id,i)=>sourceIds.has(id) && (!versions.has(id) || versions.get(id)!.has(used[i])));
      if (!sourceIds.has(String(turn.id)) && !mentions(String(turn.text)) && !linked) continue;
      hide.run(this.owner,turn.id);
      const paired=turns[index+(turn.role==='user'?1:-1)];
      if (paired && paired.role!==turn.role && paired.session_id===turn.session_id) hide.run(this.owner,paired.id);
    }
  }
  close():void { this.db.close(); }

  private remove(target:Target):boolean {
    const catalog=this.recallVersions?.()??[];
    const versions=new Map<string,Set<string>>();
    const sourceIds=new Set<string>();
    // One voice message can establish several independent facts. Match its exact
    // fact version for model receipts; keep the message ID for transcript masking.
    const track=(id:string,match:(e:RecallVersion)=>boolean)=>{
      if (!id) return;
      sourceIds.add(id);
      const candidates=catalog.filter(e=>e.sourceId===id);
      if (candidates.length) {
        const selected=versions.get(id)??new Set<string>();
        for (const e of candidates) if (match(e)) selected.add(e.version);
        versions.set(id,selected);
      }
    };
    if (target.itemId) {
      const row=this.db.prepare('SELECT content,source_msg_id,type FROM memory_item WHERE id=? AND account_id=?').get(target.itemId,this.owner);
      if (!row) return false;
      this.db.prepare('DELETE FROM memory_item WHERE id=? AND account_id=?').run(target.itemId,this.owner);
      const content=String(row.content);
      track(String(row.source_msg_id??''),e=>e.rawId===target.itemId);
      this.maskHistory(sourceIds,text=>content.length>1 && text.includes(content),versions);
      if (row.type==='preference' && row.source_msg_id) {
        const profile=this.db.prepare('SELECT interests FROM family_member WHERE account_id=?').get(this.owner);
        const interests=JSON.parse(String(profile?.interests??'[]')) as Interest[];
        const keep=interests.filter(i=>i.source_msg_id!==row.source_msg_id || ![i.value,'喜欢'+i.value,'喜欢吃'+i.value].includes(content));
        if (keep.length!==interests.length) this.db.prepare('UPDATE family_member SET interests=?,updated_at=? WHERE account_id=?')
          .run(JSON.stringify(keep),Date.now(),this.owner);
      }
      if (content.length>1) this.db.prepare("UPDATE relation_state SET self_narrative='' WHERE account_id=? AND instr(self_narrative,?)").run(this.owner,content);
      return true;
    }
    const {topic,kind}=target;
    const p=this.db.prepare(`SELECT nickname,preferred_address,interests,recent_emotion,personality_notes,
      birthday,gender,age_years FROM family_member WHERE account_id=?`).get(this.owner) as unknown as Profile;
    const known=this.db.prepare('SELECT kind,topic,value,source_msg_id FROM personal_memory_fact WHERE account_id=?').all(this.owner) as
      {kind:Fact['kind'];topic:string;value:string;source_msg_id:string}[];
    const canonicalText=new Set<string>();
    const terms=new Set<string>([topic]);
    const shortValues=new Set<string>();
    // A one-character name, gender or value may occur in many unrelated memories.
    // Remove its canonical source, never use it as a free substring across other records.
    const addValue=(s:string)=>{ if (s.length>1) terms.add(s); else if (s) shortValues.add(s); };
    let changed=false;
    for (const row of known) {
      if ((kind && row.kind!==kind) || !(row.topic===topic || (!kind && (row.value===topic || (topic.length>1 && row.value.includes(topic)))) || (kind==='name' && row.kind==='name'))) continue;
      this.db.prepare('DELETE FROM personal_memory_fact WHERE account_id=? AND kind=? AND topic=?').run(this.owner,row.kind,row.topic);
      track(row.source_msg_id,e=>e.kind===row.kind && e.topic===row.topic);
      canonicalText.add(factText({...row,quote:''}));
      if (row.kind!=='preference') addValue(row.value);
      changed=true;
    }
    const fields=new Map<string,string|null>();
    if (kind==='name' || (!kind && (p.nickname===topic || p.preferred_address===topic))) {
      addValue(p.nickname);
      addValue(p.preferred_address);
      fields.set('nickname',''); fields.set('preferred_address',''); changed ||= !!(p.nickname||p.preferred_address);
    }
    if (topic.length===1) { terms.delete(topic); shortValues.add(topic); }
    const mentions=(text:string|null) => !!text && ([...terms].some(t=>t && text.includes(t)) ||
      [...shortValues].some(t=>text===t || text==='喜欢'+t || text==='不喜欢'+t ||
        text==='不吃'+t || text==='叫我'+t || text==='昵称是'+t || text==='称呼你为'+t));
    if (!kind || kind==='fact') {
      if (/^(?:生日|出生年月|出生日期|年龄)$/u.test(topic) || (p.birthday && p.birthday===topic)) {
        if (p.birthday) terms.add(p.birthday);
        terms.add('生日'); terms.add('出生日期'); terms.add('出生年月');
        changed ||= !!p.birthday || p.age_years!==null;
        fields.set('birthday','');fields.set('age_years',null);fields.set('age_observed_at',null);
      }
      if ((topic==='性别'||topic===p.gender) && p.gender) {fields.set('gender',''); changed=true;}
    }
    for (const f of ['personality_notes','recent_emotion'] as const) if (p[f] && mentions(p[f])) {
      fields.set(f,''); changed=true;
    }
    const interests=JSON.parse(p.interests) as Interest[];
    const keep=interests.filter(i=>kind==='fact' || (kind==='preference' ? i.value!==topic : !mentions(i.value)));
    if (keep.length!==interests.length) {
      for (const item of interests) if (!keep.includes(item) && typeof item.source_msg_id==='string') track(item.source_msg_id,e=>e.kind==='preference' && e.topic===item.value);
      fields.set('interests',JSON.stringify(keep)); changed=true;
    }
    for (const [f,v] of fields)
      this.db.prepare('UPDATE family_member SET '+f+'=?,updated_at=? WHERE account_id=?').run(v,Date.now(),this.owner);
    const memory=this.db.prepare('SELECT id,content,subject,type,source_msg_id FROM memory_item WHERE account_id=?').all(this.owner) as {id:string;content:string;subject:string;type:string;source_msg_id:string}[];
    for (const m of memory) {
      if (kind==='preference') {
        const value=m.content.replace(/^(?:最)?(?:不喜欢吃|喜欢吃|不喜欢|喜欢|不爱吃|不吃|爱吃|讨厌|忌口)/u,'');
        if (value!==topic || (value===m.content && m.type!=='preference')) continue;
      } else if (kind==='fact') {
        if (!canonicalText.has(m.content) && m.content!==topic) continue;
      } else if (!mentions(m.content) && !mentions(m.subject)) continue;
      if (m.source_msg_id) track(m.source_msg_id,e=>e.rawId===m.id);
      this.db.prepare('DELETE FROM memory_item WHERE id=? AND account_id=?').run(m.id,this.owner); changed=true;
    }
    // These two prompt sections can quote the old fact even after the corresponding memory was revoked.
    for (const t of terms) {
      const shots=this.db.prepare('DELETE FROM style_pool WHERE account_id=? AND (instr(child_said,?) OR instr(xiaoke_did,?))').run(this.owner,t,t);
      const narrative=this.db.prepare("UPDATE relation_state SET self_narrative='' WHERE account_id=? AND instr(self_narrative,?)").run(this.owner,t);
      if (shots.changes || narrative.changes) changed=true;
    }
    if (changed) {
      const phrases=[...canonicalText,...[...shortValues].flatMap(value=>['喜欢','不吃','叫我','称呼你为'].map(prefix=>prefix+value))];
      this.maskHistory(sourceIds,text=>mentions(text) || text.split(/[，,。？?！!、]/u).some(part=>phrases.some(phrase=>part.endsWith(phrase))),versions);
    }
    return changed;
  }

  apply(command:MemoryCommand,room:string,userText:string,reviewItemId?:string):string {
    if (command.op==='clarify') return command.text;
    const id=randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const cut=Math.max(Date.now(),this.revision+1);
      let answer:string;
      if (reviewItemId) {
        const retired=this.db.prepare("UPDATE memory_item SET status='retracted' WHERE id=? AND account_id=? AND status='active'")
          .run(reviewItemId,this.owner);
        if (!retired.changes) throw new Error('review_item_changed');
      }
      if (command.op==='forget') {
        answer=this.remove(command.target)?'已经从长期记忆中移除了。':'没有找到这项已保存的记忆。';
      } else {
        for (const f of command.facts) {
          this.remove({kind:f.kind,topic:f.topic});
          this.db.prepare('INSERT INTO personal_memory_fact(account_id,kind,topic,value,source_quote,source_msg_id,updated_at) VALUES(?,?,?,?,?,?,?)')
            .run(this.owner,f.kind,f.topic,f.value,f.quote,id,cut);
          if (f.kind==='name') {
            this.db.prepare('UPDATE family_member SET nickname=?, preferred_address=?,updated_at=? WHERE account_id=?').run(f.value,f.value,cut,this.owner);
          } else {
            this.db.prepare(`INSERT INTO memory_item(id,account_id,type,content,subject,source,session_id,source_role,source_quote,
              created_at,source_msg_id,valid_from) VALUES(?,?,?,?,?,'personal-owner',?,'user',?,?,?,?)`)
              .run(randomUUID(),this.owner,f.kind==='preference'?'preference':'event',factText(f),'owner',room,f.quote,cut,id,cut);
            if(f.kind==='preference' && f.value==='喜欢') {
              const profile=this.db.prepare('SELECT interests FROM family_member WHERE account_id=?').get(this.owner)!;
              const interests=JSON.parse(String(profile.interests)) as Interest[];
              interests.push({value:f.topic,confidence:1,last_updated:cut,source:'voice',state:'verified',evidence:f.quote,source_msg_id:id});
              this.db.prepare('UPDATE family_member SET interests=?,updated_at=? WHERE account_id=?').run(JSON.stringify(interests),cut,this.owner);
            }
          }
        }
        answer='记住了，'+command.facts.map(factText).join('，')+'。';
      }
      this.db.prepare(`INSERT INTO personal_memory_boundary(account_id,cut) VALUES(?,?)
        ON CONFLICT(account_id) DO UPDATE SET cut=excluded.cut`).run(this.owner,cut);
      const add=this.db.prepare(`INSERT INTO dialogs.conversation(id,account_id,session_id,role,text,ts,tokens,memory_excluded)
        VALUES(?,?,?,?,?,?,0,1)`);
      add.run(id,this.owner,room,'user',userText,cut);
      const replyId=randomUUID();
      add.run(replyId,this.owner,room,'assistant',answer,cut);
      this.recordRecall(replyId);
      const hide=this.db.prepare('INSERT OR IGNORE INTO personal_history_mask VALUES(?,?)');
      hide.run(this.owner,id);hide.run(this.owner,replyId);
      this.db.exec('COMMIT');return answer;
    } catch (e) {
      this.db.exec('ROLLBACK');throw e;
    }
  }
}
