// Candidate-only output guard. Hold a possible execution-claim prefix, not an
// unrelated whole sentence: the Worker can keep its existing early TTS splits.
const IGNORABLE = /[\s，,：:]/;
const END = /[。！？!?；;…~～\n]/;
const ACTORS = ['我', '小可'];
const MODIFIERS = ['现在','这就','马上','已经','刚刚','刚','正在','会','来','可以','能','帮你','替你','先','没有','没','还没','还没有','为你','帮您','去','在网上','上网','联网','试着'];
const DENIALS = ['还查不到','还没法查','不能查','无法查','没有搜索能力'];
const WAIT = ['稍等','请稍等','等我'];
const CLAIM = /(?:我|小可)(?:现在|这就|马上|已经|刚刚|刚|正在|会|来|可以|能|帮你|替你|先|没有|没|还没|还没有|为你|帮您|去|在网上|上网|联网|试着){0,6}(?:查|搜)|(?:正在|已经|还在|马上|这就)(?:为你|帮你)?(?:查|搜)|(?:搜索|查询)(?:已经|已|正在|还没|没有)?(?:完成|开始|接单|取消|结束|失败)|(?:我|小可)(?:来|会)?帮你看看|(?:我|小可)[^。！？!?]{0,18}(?:还查不到|还没法查|不能查|无法查|没有搜索能力)|等我长大/;
const INITIAL_CLAIM = /^(?:好[的呀]?|嗯|刚才)?(?:查到|搜到|查完|搜完)/;
const STANDALONE_WAIT = /^(?:稍等|请稍等|等我)[一下会儿哦呀啦]*[。！!？?；;…~～]?$/;
// Only explicit questions/conditions qualify, not an arbitrary earlier question.
// Keep punctuation here: a new clause must regain execution-claim protection.
const NON_EXECUTION_PREFIX = new RegExp(`(?:你想让|你希望|你想要|如果)(?:(?:我|小可)(?:${MODIFIERS.join('|')}){0,6})?$`);
const nonExecution = (prefix: string) => NON_EXECUTION_PREFIX.test(prefix.replace(/[\s：:]/g, ''));
const QUOTES: Record<string,string> = { '“':'”', '‘':'’', '"':'"', "'":"'" };

/** Whether an unfinished normalized suffix can still form prefix + token{0,n}
 * + ending. A small NFA retains overlapping tokens (已/已经, 刚/刚刚), so decisions
 * do not depend on how a provider splits SSE deltas. Complete matches are dealt
 * with by CLAIM before this lookahead is used. No speculative text is emitted. */
function repeatedPrefix(s: string, prefixes: string[], tokens: string[], max: number, endings: string[]): boolean {
  for (const prefix of prefixes) {
    if (prefix.startsWith(s)) return true;
    if (!s.startsWith(prefix)) continue;
    const queue: [number, number][] = [[prefix.length, 0]];
    const seen = new Set<string>();
    while (queue.length) {
      const [at, count] = queue.pop()!;
      const key = `${at}:${count}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rest = s.slice(at);
      if (endings.some(end => end.startsWith(rest))) return true;
      if (count === max) continue;
      for (const token of tokens) {
        if (token.startsWith(rest)) return true;
        if (rest.startsWith(token)) queue.push([at + token.length, count + 1]);
      }
    }
  }
  return false;
}

function possibleClaim(s: string, initial: boolean): boolean {
  if (repeatedPrefix(s, ACTORS, MODIFIERS, 6, ['查', '搜'])
    || repeatedPrefix(s, ['正在','已经','还在','马上','这就'], ['为你','帮你'], 1, ['查','搜'])
    || repeatedPrefix(s, ['搜索','查询'], ['已经','已','正在','还没','没有'], 1, ['完成','开始','接单','取消','结束','失败'])
    || repeatedPrefix(s, ACTORS, ['来','会'], 1, ['帮你看看'])
    || '等我长大'.startsWith(s)) return true;
  // Preserve the old denial grammar, including its bounded intervening text.
  // Self-references can therefore still be held for up to 18 characters; this
  // is intentionally conservative, not a claim of zero buffering for all text.
  for (const actor of ACTORS) {
    if (actor.startsWith(s)) return true;
    if (!s.startsWith(actor)) continue;
    const rest = s.slice(actor.length);
    if (rest.length <= 18) return true;
    for (let skip = 0; skip <= 18; skip++) {
      if (DENIALS.some(end => end.startsWith(rest.slice(skip)))) return true;
    }
  }
  if (!initial) return false;
  if (repeatedPrefix(s, ['', '好', '好的', '好呀', '嗯', '刚才'], [], 0, ['查到','搜到','查完','搜完'])) return true;
  return WAIT.some(prefix => prefix.startsWith(s)
    || (s.startsWith(prefix) && /^[一下会儿哦呀啦]*$/.test(s.slice(prefix.length))));
}

function normalized(raw: string): { text: string; offsets: number[] } {
  let text = ''; const offsets: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (!IGNORABLE.test(raw[i])) { text += raw[i]; offsets.push(i); }
  }
  return { text, offsets };
}

/** Safe words already streamed cannot be retracted. If a later clause makes a
 * false claim, only that withheld suffix is replaced and the rest of its sentence
 * is discarded. Original quoted sentences and disabled/production passthrough
 * retain their prior behavior. No user text or provider text is logged here. */
export function createSearchClaimFilter(enabled: boolean) {
  let pending = ''; let emitted = 0; let quoteEnd = ''; let context = ''; let dropping = false; let warned = false;
  const reset = () => { pending = ''; emitted = 0; quoteEnd = ''; context = ''; dropping = false; };
  const remember = (text: string) => { context = (context + text).slice(-96); };
  const fallback = () => {
    if (warned) return '';
    warned = true;
    return '要查询资料，请说“帮我查一下”，再加上具体问题。';
  };
  const forbidden = (text: string, offsets: number[], finish: boolean) => {
    for (const match of text.matchAll(new RegExp(CLAIM.source, 'g'))) {
      if (!nonExecution(context + pending.slice(0, offsets[match.index!]))) return true;
    }
    return emitted === 0 && (INITIAL_CLAIM.test(text) || (finish && STANDALONE_WAIT.test(text)));
  };
  return {
    feed(delta: string): string {
      if (!enabled) return delta;
      let out = '';
      for (const char of delta) {
        if (dropping) { if (END.test(char)) reset(); continue; }
        if (quoteEnd) {
          out += char; emitted++; remember(char);
          if (char === quoteEnd) quoteEnd = '';
          // An unclosed quote cannot disable the rest of a multi-sentence reply.
          if (END.test(char)) reset();
          continue;
        }
        if (QUOTES[char]) {
          out += pending + char; emitted += normalized(pending).text.length + 1;
          remember(pending + char); pending = ''; quoteEnd = QUOTES[char];
          continue;
        }
        pending += char;
        const { text, offsets } = normalized(pending);
        const finish = END.test(char);
        if (forbidden(text, offsets, finish)) {
          out += fallback(); pending = ''; dropping = true;
          if (finish) reset();
        } else if (finish) {
          out += pending; reset();
        } else if (pending.length > 512) {
          out += fallback(); pending = ''; dropping = true;
        } else {
          let keep = text.length;
          for (let i = 0; i < text.length; i++) {
            if (possibleClaim(text.slice(i), emitted === 0 && i === 0)
              && !nonExecution(context + pending.slice(0, offsets[i]))) { keep = i; break; }
          }
          const at = keep === text.length ? pending.length : offsets[keep];
          out += pending.slice(0, at); remember(pending.slice(0, at)); pending = pending.slice(at); emitted += keep;
        }
      }
      return out;
    },
    flush(): string {
      if (!enabled || dropping) { reset(); return ''; }
      const {text,offsets}=normalized(pending);
      const out = !quoteEnd && forbidden(text, offsets, true) ? fallback() : pending;
      reset(); return out;
    },
  };
}
