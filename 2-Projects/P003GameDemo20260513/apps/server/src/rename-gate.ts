/**
 * 语音改称呼硬门 v2（2026-09-03 川哥拍板：孩子自己改昵称是日常交流记忆的一种，要放开）。
 *
 * 背景：8-26 的五门把句式集收得太窄（只认「以后/请/就叫我X」「叫我X吧」「改名叫X」），上线 8 天
 * 四台 1051 轮零成功——孩子/川哥真实说法「叫我川哥」「你可以叫我川哥」「给我换个称呼不要喊我主人」
 * 「把我名字给改了」全部被拒，而门拒日志与噪声（候选=旧名/小可）同形，没人发现。
 *
 * 设计原则不变：**prompt 里的约束不是门，服务端能机验的才是门**。LLM 只交候选 value + 照抄原话的
 * evidence，这里做结构校验：
 *   ① evidence 必须是孩子某条消息的真实连续子串（≥2 字）；
 *   ② 三种句式层级任一命中：
 *      A 显式触发词（以后/请/就/可以/要/都/记住…叫我 · 改名叫 · 换个称呼 · 名字改成 · 我的名字叫 ·
 *        别叫我A了叫我B）——新称呼必须紧跟在触发词之后（≤3 字间隔，防「川哥叫我起床」倒装误中）；
 *        触发词前若是第三人称/转述主语（他/妈妈/老师/大家都…叫我）= 转述别人怎么叫，不算请求；
 *      B 裸句式整句（「叫我川哥」「你叫我川哥」「我叫川哥」「我不叫指挥官我叫川哥」）：整条消息去掉
 *        语气词/标点后必须恰好以新称呼结尾——「我叫妈妈来吃饭」尾巴不是名字，天然拒；
 *      C ASR 切句（「以后叫我」+「川哥」两条消息）：前一条整句以触发词结尾、后一条整句恰好=新称呼；
 *   ③ 新称呼合法（长度/符号/注入词/代词/AI 名/动作词/家庭角色词黑名单）且 ≠ 当前称呼。
 * 每个拒绝都带 reason，日志能区分「噪声」和「真意图被拒」（后者才值得回头调句式集）。
 */

export type GateTurn = { role: 'user' | 'assistant'; content: string };

export type RenameCheck =
  | { ok: true; nickname: string; evidence: string; tier: 'A' | 'B' | 'C' }
  | { ok: false; reason: RenameRejectReason; value: string };

export type RenameRejectReason =
  | 'no_value'
  | 'evidence_not_in_user_text'
  | 'same_as_current'
  | 'invalid_name'
  | 'no_intent';

/** 字段清洗：去控制字符 + 去 <>（防存储型 XSS）+ 截断（字符数组阶段 slice，不砍断 emoji）。 */
export function clipText(raw: string, max: number): string {
  return [...raw]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return !(code < 0x20 || code === 0x7f) && ch !== '<' && ch !== '>';
    })
    .join('')
    .trim()
    .slice(0, max);
}

/** 不是称呼的词：动作/疑问/家庭角色（家长对着设备说「叫我妈妈」不该改写孩子的档案——一台一称呼槽）。 */
const NON_NAME_WORDS =
  /^(起床|吃饭|睡觉|回家|过来|过去|出来|进来|回来|一声|一下|干嘛|干什么|做什么|什么|谁|怎么|哪里|哪儿|帮忙|帮我|等等|等一下|停|闭嘴|爸爸|妈妈|爸|妈|爷爷|奶奶|外公|外婆|姥姥|姥爷|老师|同学|朋友|宝贝儿子|儿子|女儿)$/;

/** 昵称合法性：长度 1-12、无特殊/注入符号、无系统/注入关键词、非代词/AI 名/动作词/家庭角色。 */
export function isValidNickname(name: string): boolean {
  if (name.length < 1 || name.length > 12) return false;
  if (/[<>{}[\]/\\|@#$%^&*=+`~]/.test(name)) return false;
  if (/忽略|指令|system|prompt|ignore|assistant|叫我$/i.test(name)) return false;
  // 代词/AI 自己的名字不是称呼（2026-08-26：004 曾被 onboarding 抽成「你」、0010 曾被抽成「小可」）
  if (/^(你|我|他|她|它|咱|你们|我们|他们|她们|大家|小可)$/.test(name)) return false;
  if (NON_NAME_WORDS.test(name)) return false;
  return true;
}

// ── 句式层级 A：显式触发词（新称呼必须紧跟其后）──
const TIER_A_TRIGGERS: RegExp[] = [
  // 以后/请/就/可以/要/都/记住…(再)叫我X
  /(?:以后|之后|下次|从今天起|从现在起|从今以后|现在起|现在|请|就|都|可以|能|要|得|应该|直接|一律|记住|记得|还是|不如)(?:你|你们)?(?:再|直接|都|就)?(?:叫|喊|称呼|称|管)我/g,
  // 别叫我A了(，)叫我B —— 取后一个「叫我」
  /(?:别|不要|不许|不准|不用|不能|不想)(?:再)?(?:叫|喊|称呼)我[^，,。、！!？? ]{1,10}?(?:了)?[，,。、！!？? ]*(?:你)?(?:就|直接|以后)?(?:叫|喊|称呼)我/g,
  // 改名叫X / 我想改名叫X / 名字改成X / 换个称呼叫X / 我的名字叫X
  /我(?:想|要|得|准备)?改名(?:叫|为|成)?/g,
  /改名(?:叫|为|成)/g,
  /换个(?:名字|称呼|叫法|外号)(?:叫|吧|，|,)?/g,
  /(?:名字|称呼|外号|昵称)(?:改成|换成|改为|换为|就叫|叫|是)/g,
  /我的(?:新)?名字(?:是|叫)/g,
];

/** 触发词前是这些主语 = 转述别人怎么叫我（「他们都叫我小胖」），不是对小可的请求；
 *  前一个字是否定词 = 「不要喊我主人」里的「要喊我」不是请求（层级 A 第二条专门处理「别叫我A了叫我B」）。 */
const THIRD_PERSON_BEFORE_RE =
  /(?:他|她|它|们|老师|同学|妈妈|爸爸|爷爷|奶奶|外公|外婆|姥姥|姥爷|哥哥|姐姐|弟弟|妹妹|朋友|大家|别人|人家|总是|老是|经常|喜欢|爱|不|别|没|莫)$/;

/** 整句尾部语气词/标点剥离（层级 B/C 用整句判形）。 */
const TAIL_PARTICLES_RE =
  /(?:吧|好啦|好了|好么|好吗|好不好|行不|行不行|行吗|行么|就行|就好|就可以|可以吗|可以么|嘛|呀|哦|啊|哈|啦|呢|好吗|了)+$/;
const PUNCT_RE = /[\s，,。.、！!？?～~：:；;「」『』“”"'‘’（）()【】\[\]…—-]+/g;

function normalizeUtterance(text: string): string {
  let t = text.replace(PUNCT_RE, '');
  // 反复剥尾巴：「叫我川哥吧好吗」→「叫我川哥」
  for (let i = 0; i < 3; i += 1) {
    const next = t.replace(TAIL_PARTICLES_RE, '');
    if (next === t) break;
    t = next;
  }
  return t;
}

// ── 句式层级 B：裸句式整句（整条消息恰好以新称呼结尾）──
const TIER_B_RES: RegExp[] = [
  // (你|小可)(以后|就|都)叫我X
  /^(?:小可|嗨|你好)?(?:你|你们)?(?:以后|之后|就|都|再|直接|可以|要|得|能)?(?:你|你们)?(?:就|都|再|直接)?(?:叫|喊|称呼|称|管)我(.{1,12})$/,
  // (我不叫A)我叫X —— 前缀不能是第三人称（他/妈妈…叫）：整句必须以「我叫」引出名字
  /^(?:小可|你好|嗨|哈喽|喂)?(?:记住|记得|记好|告诉你)?(?:我不叫.{1,12})?我叫(.{1,12})$/,
  // 「我是X」故意不放：「我是男孩」「我是老大」这类 NON_NAME 兜不住，宁漏。
];

// ── 句式层级 C：ASR 切句（前句以触发词结尾 + 后句整句=新称呼）──
const TIER_C_PREV_RE =
  /^(?:小可|你|你们)?(?:以后|之后|下次|请|就|都|可以|能|要|得|应该|直接|记住|记得)?(?:再)?(?:叫|喊|称呼|称|管)我$/;

function tierA(ev: string, n: string): boolean {
  for (const re of TIER_A_TRIGGERS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ev)) !== null) {
      const end = m.index + m[0].length;
      if (THIRD_PERSON_BEFORE_RE.test(ev.slice(0, m.index))) continue;
      const at = ev.indexOf(n, end);
      if (at >= 0 && at - end <= 3) return true;
      if (m[0].length === 0) re.lastIndex += 1; // 防零宽死循环（当前触发词不会零宽，保险）
    }
  }
  return false;
}

function tierB(fullMessage: string, n: string): boolean {
  const u = normalizeUtterance(fullMessage);
  for (const re of TIER_B_RES) {
    const m = re.exec(u);
    if (m && m[1] === n) return true;
  }
  return false;
}

/** 前一条孩子消息以触发词结尾 + 后一条整句恰好是新称呼。返回拼接证据或 null。 */
function tierC(userTexts: string[], n: string): string | null {
  for (let i = 0; i + 1 < userTexts.length; i += 1) {
    const prev = normalizeUtterance(userTexts[i]!);
    const next = normalizeUtterance(userTexts[i + 1]!);
    if (prev.length <= 16 && TIER_C_PREV_RE.test(prev) && next === n) {
      return `${userTexts[i]}｜${userTexts[i + 1]}`;
    }
  }
  return null;
}

/**
 * 改称呼候选硬校验（纯函数，供单测）。history 只看 user 消息。
 * 通过时返回记账用 evidence（层级 C 为两条消息拼接）。
 */
export function checkRenameCandidate(
  value: unknown,
  evidence: unknown,
  history: GateTurn[],
  currentNickname: string,
): RenameCheck {
  const n = typeof value === 'string' ? clipText(value, 12) : '';
  if (!n) return { ok: false, reason: 'no_value', value: '' };
  const ev = typeof evidence === 'string' ? clipText(evidence, 60) : '';
  const userTexts = history.filter((t) => t.role === 'user').map((t) => t.content);
  // 噪声先判（候选=旧名 / 黑名单）——这两类拒绝不值得回头调句式集，日志按 reason 分流
  if (n === currentNickname) return { ok: false, reason: 'same_as_current', value: n };
  if (!isValidNickname(n)) return { ok: false, reason: 'invalid_name', value: n };
  const evReal = ev.length >= 2 && userTexts.some((t) => t.includes(ev));
  // 层级 C 不依赖 LLM 的 evidence（它给不出跨消息证据）
  const joined = tierC(userTexts, n);
  if (joined) return { ok: true, nickname: n, evidence: joined, tier: 'C' };
  if (!evReal) return { ok: false, reason: 'evidence_not_in_user_text', value: n };
  if (ev.includes(n) && tierA(ev, n)) return { ok: true, nickname: n, evidence: ev, tier: 'A' };
  // 层级 B 看包含 evidence 的整条消息（LLM 常只抄半句）
  const host = userTexts.find((t) => t.includes(ev));
  if (host && tierB(host, n)) return { ok: true, nickname: n, evidence: host.slice(0, 60), tier: 'B' };
  return { ok: false, reason: 'no_intent', value: n };
}
