import { detectStyleIntent } from './p003/style-intent.js';
import { getStyleTemplate, type StyleTemplateKey } from './p003/style-template.js';
import { traitStore } from './p003/trait-store.js';

type Style = StyleTemplateKey | 'default';
type Turn = {role: string; content: string};
type Instruction = {key?: Style; temporary: boolean; request: string};
type Resolution = {key?: Style; temporary: boolean; request: string; policyLine: string; reply?: string; consume?: () => void};
type RoomStyle = {pending?: Style; used?: Style};
const rooms = new Map<string,RoomStyle>();
function remember(room: string, slot: RoomStyle) {
  rooms.delete(room);
  if (rooms.size >= 128) rooms.delete(rooms.keys().next().value!);
  rooms.set(room,slot);
}

const once = /^(?:仅限|仅仅|只是|仅|只|就)?(?:这一次|这一回|这次|这一轮|这轮|这回|这一句|这句|这条|这个问题|这道题|这段回答|这次回答)/u;
const longTerm = /^(?:从今(?:天|儿)?起|从今(?:天|儿)?开始|从现在(?:起|开始)|今后|此后|以后|往后|接下来每次|之后每次|每次|每回|总是|长期|一直)/u;
const switchTo = /^(?:切换(?:到|成|为)?|切到|切成|换成|换个|换回|调成|改成|改得|设成|设为|设置成|设置为)/u;
const discourse = /^(?:小可|(?:请)?记住|麻烦你?|请你?|我希望你?|我想让你|咱们聊天(?:时|的时候)?|和我聊天(?:时|的时候)?|你的?|咱们|可以|能不能|能否|可不可以|还是|都|就|要|先|用|把|让|按|语气|语调|风格|说话(?:时|的时候)?|说得|聊天(?:时|的时候)?|表达(?:得|的)?|回答(?:得|的|我|问题)?|回复(?:得|的|我)?|尽量|保持)/u;
const ending = /^(?:的(?:方式|语气|风格)|地|的?模式|风格|的?语气|(?:来)?(?:回复|回答)(?:我)?|跟我聊天|和我聊天|来说(?:话)?|说话|就(?:可以|行|好)|就够了|可以了|好了|吧|呀|哈|好不好|行不行|可以吗|啊|些|一点|一些|点)+/u;
const inlineQuestion = /^(?:告诉我|帮我|给我|我想知道|带我|解释|介绍|讲|说说|聊聊|写|念|分析|举个|请问|为什么|为何|什么|怎么|谁|今天|明天|现在|查|搜|请|回答)|(?:怎么样|是怎么回事|几号|几点|有多[高长大])$/u;
const carry = /^(?:以后|往后|今后|从现在起)(?:都|一直|就|也|请|按|像|照|保持|采用|用)*(?:(?:刚才|刚刚|上一次|上一轮|上次)(?:的)?(?:那样|那种|这样|那么)?|这么|这样|那样|这种|这个)(?:的?(?:说话风格|风格|方式|语气)|说话|回答|聊天|说|来|吧|即可|就好|就行)*$/u;
const alias: [Style, RegExp][] = [
  ['quiet', /^(?:直奔主题|直说重点|只说重点|直接说重点|言简意赅|简洁明了|简(?:洁|短|练)(?:一些|一点|点|些)?|简明扼要|惜字如金|长话短说|(?:只用|只说|只需|控制在|用)?(?:一两句(?:话)?|一句话|两句话)(?:内|就)?(?:说完|说清楚|说清|讲完|回答|回复)?)/u],
  ['chatty', /^(?:健谈(?:一些|一点|点|些)?|多聊聊|聊(?:详细|细致)(?:一点|一些|点|些)?|详细(?:一些|一点|点|些)|展开(?:一些|一点|点|些)|话痨)/u],
  ['funny', /^(?:更?幽默(?:一些|一点|点|些)?|轻松幽默|诙谐(?:一些|一点|点|些)?|风趣(?:一些|一点|点|些)?|搞笑(?:一些|一点|点|些)?)/u],
  ['default', /^(?:默认(?:小可)?|默认的?|平常的|正常的|原来的)(?=风格|模式|语气|方式|说话|回答|回复|$)/u],
];
const names: Record<Style,string> = {quiet:'简短些',chatty:'多展开一点',funny:'幽默些',default:'用平常的语气'};

function parse(text: string): Instruction | undefined {
  if (!text || text.length > 2000 || /[“「『"][^”」』"]*(?:简短|简洁|幽默|直奔主题|多聊|搞笑)[^”」』"]*[”」』"]/u.test(text)) return;
  const normalized = text.normalize('NFKC');
  const parts = normalized.split(/(?<=[,，。！？!？?;；、\n])/u);
  const remaining: string[] = [];
  let key: Style | undefined, temporary = false, lasting = false, carryPrevious = false;
  let prefix: string[] = [];
  // Scope and style may straddle an ASR comma: “以后，咱们直奔主题，一两句就行”。
  for (const original of parts) {
    const phrase = original.replace(/[\s,，。！？!?;；、]+/gu, '');
    if (!phrase) continue;
    if (carry.test(phrase)) {
      carryPrevious = true; lasting = true; prefix = []; continue;
    }
    let rest = phrase, thisOnce = false, thisLasting = false;
    while (rest) {
      const o = once.exec(rest), l = longTerm.exec(rest), s = switchTo.exec(rest);
      const pre = o ?? l ?? s ?? discourse.exec(rest);
      if (!pre) break;
      thisOnce ||= !!o;
      thisLasting ||= !!l || !!s;
      rest = rest.slice(pre[0].length);
    }
    if (!rest && (thisOnce || thisLasting)) {
      prefix.push(original); temporary ||= thisOnce; lasting ||= thisLasting; continue;
    }
    const hit = detectStyleIntent(rest);
    const extra = alias.find(([, r]) => r.test(rest));
    const found = hit && rest.startsWith(hit.matched) ? [hit.key, hit.matched] as const
      : extra ? [extra[0], rest.match(extra[1])![0]] as const : undefined;
    if (found) {
      let tail = rest.slice(found[1].length).replace(ending, '');
      // Inline content following an instruction must survive, including “一句话告诉我今天几号”.
      if (tail && !inlineQuestion.test(tail)) {
        remaining.push(...prefix,original); prefix = []; continue;
      }
      tail = tail.replace(/^(?:告诉我|请问)/u, '');
      if (tail) remaining.push(tail + (original.match(/[。！？!?]$/u)?.[0] ?? ''));
      key = found[0]; temporary ||= thisOnce; lasting ||= thisLasting || (key === 'default' && /^(?:恢复|切回|换回)/u.test(rest)); prefix = []; continue;
    }
    remaining.push(...prefix,original); prefix = [];
  }
  if (!key && !carryPrevious) return;
  const request = remaining.concat(prefix).join('').trim().replace(/^[,，;；\s]+|[,，;；\s]+$/gu,'');
  return {key, temporary: temporary || !lasting, request};
}

/** Keep the actual content question and answer, excluding expired style instructions from the next turn. */
export function styleHistory<T extends Turn>(turns: readonly T[]): T[] {
  const result: T[] = [];
  let skipAcknowledgement = false;
  for (const turn of turns) {
    if (turn.role === 'user') {
      const instruction = parse(turn.content);
      skipAcknowledgement = !!instruction && !instruction.request;
      if (!skipAcknowledgement) result.push(instruction ? {...turn,content:instruction.request} : turn);
    } else if (turn.role !== 'assistant' || !skipAcknowledgement) {
      result.push(turn);
    }
  }
  return result;
}

function policy(key: Style, temporary: boolean): string {
  const scope = temporary ? '仅限本次回答' : '这是已保存的长期设置';
  const rule = key === 'default' ? '用自然、温暖、平衡的中文口语。' : getStyleTemplate(key)!.styleRule;
  return `本轮表达要求（${scope}）优先于以往的表达模板和话语量倾向。${rule}直接回答本轮的具体问题。`;
}

export function resolvePersonalStyle(account: string, user: string, store: boolean, history: readonly Turn[], room?: string): Resolution | undefined {
  const id = room && store ? account + '/' + room : undefined;
  const slot = id ? rooms.get(id) : undefined;
  const instruction = parse(user);
  if (!instruction) {
    const unhandled = /^(?:小可[，,、 ]*)?(?:我希望你?|请你?)?(?:以后|今后|往后|从现在起|从现在开始)(?:你|都|要|请|希望你|能不能|尽量)*(?:回答|回复|讲话|说话|语气|风格)(?:可以|得|要|再|更)?(?:温柔|严肃|正式|专业|稳重|委婉|俏皮|冷淡|热情)(?:一点|一些|些|点)?[呀啊吧吗。！？，!?,\s]*$/u.test(user);
    if (unhandled) return {temporary:true,request:'',policyLine:'',reply:'我可以长期设为简短、健谈、幽默或默认。你想用哪一种？'};
    if (!id || !slot?.pending) {
      if (id) rooms.delete(id);
      return;
    }
    const key = slot.pending;
    return {key,temporary:true,request:user,policyLine:policy(key,true),consume() {
      // A tool or a cancelled reply must not spend the pending conversational answer.
      if (rooms.get(id) === slot) rooms.set(id,{used:key});
    }};
  }
  const {request} = instruction;
  const lastUser = history.findLast(turn => turn.role === 'user');
  const key = instruction.key ?? slot?.pending ?? slot?.used ?? (lastUser && parse(lastUser.content)?.key);
  if (!key) {
    return {temporary:true, request, policyLine:'', reply:'你想让我以后怎么说？可以简短些、多聊些，或者幽默些。'};
  }
  const temporary = instruction.temporary || !store;
  if (!temporary && (traitStore.getTemplate(account) ?? 'default') !== key) {
    try {
      traitStore.setTemplate(account, key, {source:'voice', quote:user});
      if ((traitStore.getTemplate(account) ?? 'default') !== key) throw new Error('style_readback');
    } catch {
      return {key, temporary:true, request, policyLine:'', reply:'刚才没能保存说话风格。'};
    }
  }
  if (id) {
    if (temporary && !request) remember(id,{pending:key});
    else if (temporary) remember(id,{used:key});
    else rooms.delete(id);
  }
  const reply = request ? undefined : !store
    ? '临时对话只对当前回答生效，把风格要求和问题放在同一句就可以。'
    : temporary && id ? `好，下一问我${names[key]}。` : `好，${temporary ? '这次' : '以后'}我${names[key]}。`;
  return {key,temporary,request,policyLine:policy(key,temporary),reply};
}
