import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { assembleSystemPrompt } from './p003/prompt-orchestrator.js';
import { checkRenameCandidate } from './p003/rename-gate.js';

type Evidence = {kind: string; topic: string; value: string; quote: string; id?: string};
type Saved = {kind: string; topic: string; value: string; source_quote: string; original: string};
type Item = {id: string; role: string; type: string; content: string; original: string; source_quote: string};
const unknown = '我不记得这件事，没有能核实的记录。';
const nickname = /(?:怎么|如何)(?:叫|称呼|喊)我|(?:叫|称呼|喊)我(?:什么|啥)|我(?:的)?(?:名字|称呼|姓名|昵称|外号)|我叫(?:什么|啥)|我是谁|怎么叫我/u;
const dislike = /不喜欢|不爱(?:吃|喝)?|讨厌|忌口|不吃|不喝|避开|过敏/u;
const dietary = /口味|忌口|食材|食物|吃|喝|菜|零食|过敏/u;
const personal = /我(?:的|最|平时|平常|通常|喜欢|爱吃|爱喝|不爱|不吃|不喝|讨厌|不喜欢|以前|之前|上次|曾经|说过|提过|交代过|平时|亲口|叫|吃饭|现在|目前|如今)|(?:叫|称呼|喊)我/u;
const asks = /[？?]|吗|么|什么|啥|哪|多少|几(?:个|号|次|岁|月|点)|是否|有没有|是不是|会不会|还记(?:不记得|得)|是(?:(?:多少|谁)|否)|怎么样|如何|怎么|告诉我|说说|讲讲|是谁|呢/u;
const recallCue = /(?:你|小可)(?:还|可|都|到底)?记(?:不记得|得|住)|你(?:还)?知道我|(?:我|咱们|我们)(?:曾经|以前|之前|上回|上次|刚才|刚刚|刚|亲口|明确|有没有|有没|都|跟你|和你|让你|说|告诉|提|交代|聊|约定|说好){1,6}(?:过|的|你|没|什么)|(?:记忆|印象)里|记得我的|你对我(?:的了解|了解多少|知道多少)|关于我.{0,5}(?:记得|记住)|你记下了什么/u;
const genericOverview = /(?:记得|记住|知道|了解)(?:了)?(?:我|关于我|我的)?(?:些什么|些什么事|哪些事|哪些|什么|多少)(?:啊|呢|吗|了)?[。？?！!]*$|关于我.{0,4}(?:记得|知道)(?:些|了)?什么|我的(?:记忆|个人资料)(?:里)?有(?:哪些|什么)/u;
const normalize = (s: string) => s.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu,'').toLowerCase();
const clauses = (s: string) => s.split(/[。！？!?，,；;\n]/u).map(x=>x.trim()).filter(Boolean);
const cleanEvidence = (s: string) => s.length > 0 && s.length < 180 && !/[<>\n]|https?:\/\/|忽略.{0,6}(?:指令|规则)/iu.test(s);
const affirmative = (s:string) => !asks.test(s) && !/[“”「」"]|假设|如果|假如|要是|开玩笑|举例|(?:他说|她说|朋友说)|没(?:有)?说过|并(?:不|没有)|我以为你|不代表/u.test(s);
const fold = (s: string) => normalize(s).replace(/不(?:太)?(?:爱|喜欢)(?:吃|喝)?|讨厌(?:吃|喝)?/gu, '不喜欢').replace(/(?:喜欢|爱)(?:吃|喝)/gu,'喜欢');

export function asksForMemory(text: string): boolean {
  if (!asks.test(text)) return false;
  // “你知道我该怎么坐地铁吗” asks for advice, while “你记得我上次怎么去的吗” asks for history.
  if (/(?:你知道|告诉我)我(?:现在|接下来)?(?:该|应该|能|可以|要)?(?:怎么|如何|怎样)/u.test(text) && !/上次|以前|曾经|说过|告诉过/u.test(text)) return false;
  if (recallCue.test(text) && /我|以前|之前|上次|刚才|刚刚|说过|聊过|约定|记忆/u.test(text)) return true;
  if (nickname.test(text)) return true;
  if (/(?:我的|我当时说的).{1,18}(?:记得吗|还记得吗|是什么|是哪|叫什么)|我(?:最|比较)喜欢(?:哪个|哪位|的.{1,12}是)|你知道我.{1,15}(?:吗|什么|哪)/u.test(text)) return true;
  return personal.test(text) && /我(?:现在|目前|如今|最|一般|平时|通常|不太)?(?:喜欢|爱吃|爱喝|不爱|不吃|不喝|讨厌|不喜欢).{0,12}(?:什么|哪|吗|谁|啥)|我(?:的|最喜欢的).{1,16}(?:是什么|是啥|是哪个|叫什么|是哪|是谁|是多少|几岁|是几|呢|还记得)|我(?:平时|平常).{0,16}(?:什么|哪)|我.{0,18}会愿意.{0,10}吗/u.test(text);
}

function legacyPreference(item: Item): Evidence | undefined {
  const content = fold(item.content);
  const sign = content.startsWith('不喜欢') ? '不喜欢' : content.startsWith('喜欢') ? '喜欢' : '';
  if (!sign) return;
  const topic = content.slice(sign.length);
  // Match the asserted polarity as well as the subject against a real user statement.
  const quote = clauses(item.original).find(x => affirmative(x) && /^(?:请记住|记住)?(?:我|本人)(?:最|特别|很|其实|也|还是|真的|平时|一直|非常|比较|现在|已经|一点也|不太)*(?:喜欢|不喜欢|爱吃|爱喝|不爱|讨厌)/u.test(x) && fold(x).includes(sign + topic)
    && !(sign === '喜欢' && fold(x).includes('不喜欢' + topic)));
  return topic && quote ? {kind:'preference',topic,value:sign,quote} : undefined;
}

function positiveHit(text: string, item: Evidence) {
  if (item.kind === 'name') return false;
  return item.topic.length >= 2 && normalize(text).includes(normalize(item.topic))
    || item.kind === 'fact' && item.value.length >= 2 && normalize(text).includes(normalize(item.value));
}

function say(e: Evidence) {
  if (e.kind === 'name') return '你让我叫你' + e.value + '。';
  if (e.kind === 'preference') return '你说过你' + e.value + e.topic + '。';
  if (e.kind === 'assistant-promise') return '我当时答应过：“' + e.quote + '”。';
  if (e.kind === 'fact') return '你说过，你的' + e.topic + '是' + e.value + '。';
  return '你当时说的是：“' + e.quote + '”。';
}

export class PersonalRecall {
  private db: DatabaseSync;
  constructor(dataDir: string) {
    this.db = new DatabaseSync(join(dataDir,'profile.sqlite'), {readOnly:true});
    this.db.exec('PRAGMA query_only=ON');
    this.db.prepare('ATTACH DATABASE ? AS conv').run(join(dataDir,'conversations.sqlite'));
  }
  close(): void { this.db.close(); }

  private evidence(owner: string): Evidence[] {
    const explicit = this.db.prepare(`SELECT f.kind,f.topic,f.value,f.source_quote,c.text AS original
      FROM personal_memory_fact f JOIN conv.conversation c ON c.id=f.source_msg_id AND c.account_id=f.account_id
      WHERE f.account_id=? AND c.role='user' ORDER BY f.updated_at DESC`).all(owner) as Saved[];
    const result: Evidence[] = explicit.filter(f => cleanEvidence(f.topic) && cleanEvidence(f.value)
      && f.source_quote && f.original.includes(f.source_quote)).map(f=>({...f,quote:f.source_quote}));
    const profile = this.db.prepare('SELECT nickname,interests FROM family_member WHERE account_id=?').get(owner) as {nickname:string;interests:string}|undefined;
    if (profile?.nickname && !result.some(e=>e.kind==='name')) {
      const name = profile.nickname;
      const turns = this.db.prepare(`SELECT text FROM conv.conversation WHERE account_id=? AND role='user'
        AND memory_excluded=0 AND instr(text,?)>0 ORDER BY ts DESC`).all(owner,name) as {text:string}[];
      const supported = turns.some(({text}) => clauses(text).some(part=>affirmative(part) &&
        checkRenameCandidate(name,part,[{role:'user',content:text}],'').ok));
      if (supported) result.push({kind:'name',topic:'称呼',value:name,quote:name});
    }
    const rows = this.db.prepare(`SELECT m.id,m.type,m.content,m.source_quote,c.role,c.text AS original FROM memory_item m
      JOIN conv.conversation c ON c.id=m.source_msg_id AND c.account_id=m.account_id
      WHERE m.account_id=? AND m.status='active' AND (c.role='user' OR (m.type='promise' AND m.subject='xiaoke' AND c.role='assistant')) AND c.memory_excluded=0 ORDER BY m.created_at DESC`).all(owner) as Item[];
    for (const row of rows) {
      if (!cleanEvidence(row.content)) continue;
      let item = row.type === 'preference' ? legacyPreference(row) : undefined;
      if (!item && row.type !== 'preference') {
        const quote = clauses(row.original).find(x => affirmative(x) && cleanEvidence(x) &&
          normalize(x).includes(normalize(row.content)) && (!row.source_quote || row.original.includes(row.source_quote)));
        if (quote) item = {kind:row.role==='assistant'?'assistant-promise':row.type,topic:row.content,value:row.content,quote};
      }
      if (item && !result.some(e=>e.topic===item!.topic)) result.push({...item,id:row.id});
    }
    if (profile?.interests) {
      const source = this.db.prepare("SELECT text FROM conv.conversation WHERE id=? AND account_id=? AND role='user' AND memory_excluded=0");
      for (const i of JSON.parse(profile.interests) as {state?:string;value:string;evidence?:string;source_msg_id?:string}[]) {
        if (i.state==='retracted' || !i.source_msg_id || !i.evidence || !cleanEvidence(i.value) || result.some(e=>e.topic===i.value)) continue;
        const original = source.get(i.source_msg_id,owner)?.text;
        if (typeof original==='string' && original.includes(i.evidence) && fold(i.evidence).includes('喜欢'+fold(i.value))
          && !fold(i.evidence).includes('不喜欢') && affirmative(i.evidence)) result.push({kind:'preference',topic:i.value,value:'喜欢',quote:i.evidence});
      }
    }
    return result;
  }

  chatPrompt(base: string, owner: {accountId:string;role:string}, text: string): string {
    const facts = this.evidence(owner.accountId);
    const selected = [...facts.filter(f=>positiveHit(text,f)), ...facts.filter(f=>!positiveHit(text,f))].slice(0,8);
    const lines = selected.map(f => f.kind==='assistant-promise' ? '小可当时的承诺 ' + JSON.stringify(f.quote)
      : '主人已核实的信息 ' + JSON.stringify({主题:f.topic,内容:f.value}));
    return assembleSystemPrompt(base, null, owner, null, null, null, null, null,
      {personalMemory:{lines,ids:selected.flatMap(f=>f.id?[f.id]:[])}});
  }

  answer(owner: string, text: string, store: boolean): string | undefined {
    if (!asksForMemory(text)) return;
    if (!store) return '这次是临时对话，我没有读取你的长期记忆。';
    const facts = this.evidence(owner);
    const questions = text.split(/[，,。？！?!；;]|(?:以及|还有)(?=我)/u)
      .map(s=>s.trim()).filter(s=>s && asksForMemory(s + '？') &&
        (nickname.test(s) || /什么|啥|哪|多少|是谁|怎么叫|怎么称呼|几岁|几号|避开/u.test(s)));
    if (questions.length > 1) return [...new Set(questions.map(q=>this.answerFrom(facts,q)))].join('');
    return this.answerFrom(facts,text);
  }

  private answerFrom(facts: Evidence[], text: string): string {
    const parts: string[] = [];
    const name = nickname.test(text);
    if (name) {
      const found = facts.find(e=>e.kind==='name');
      parts.push(found ? say(found) : '我不记得你希望我怎么称呼你。');
    }
    const hits = facts.filter(e=>positiveHit(text,e));
    if (hits.length) return parts.concat(hits.slice(0,3).map(say)).join('');
    // Only enumerate when the user asks for a list. A named topic with no evidence
    // must not be answered with unrelated preferences from this owner's profile.
    const wantsList = /(?:不爱|不喜欢|讨厌|避免|避开|忌口|不吃|不喝)(?:吃|喝|的|哪两种|哪些|什么|哪种|啥|哪几种|有什么)*(?:食材|食物|菜|东西|口味)?(?:[？?。！!]|呢|吗|$)|吃饭会避开什么/u.test(text);
    if (wantsList && (dislike.test(text) || dietary.test(text))) {
      const disliked = facts.filter(e=>e.kind==='preference' && e.value==='不喜欢');
      parts.push(disliked.length ? '你说过不喜欢' + disliked.slice(0,4).map(e=>e.topic).join('、') + '。' : '我不记得你明确说过的忌口。');
    } else if (!name && /(?:我(?:现在|目前|如今|都|最)?喜欢(?:吃|喝)?什么|我的(?:兴趣|爱好)(?:是|有)?什么)[？?。！!呢吗]*$/u.test(text)) {
      const liked=facts.filter(e=>e.kind==='preference' && e.value==='喜欢');
      if (liked.length) parts.push('你说过喜欢' + liked.slice(0,4).map(e=>e.topic).join('、') + '。');
    } else if (!name && genericOverview.test(text)) {
      parts.push(...facts.slice(0,3).map(say));
    }
    if (!parts.length) {
      const label = /(?:我的|我当时说的)([\p{L}]{1,12}?)(?:到底)?(?:是什么|是啥|是什么颜色|是哪|叫什么|是谁|是多少)/u.exec(text)?.[1];
      if (label && !/以前|之前|说过|告诉/u.test(label)) return '我不记得你的' + label + '。';
    }
    return parts.join('') || unknown;
  }
}
