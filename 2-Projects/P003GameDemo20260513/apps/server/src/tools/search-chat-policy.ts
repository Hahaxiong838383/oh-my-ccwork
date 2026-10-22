/** Candidate-only capability description. No user profile copying or search execution. */
export function searchChatPolicy(input: {candidate:boolean;enabled:boolean;role:string;room:string;allowed:string[]}) {
 const sn=/^sn-(BJP003\d{14})-\d+$/.exec(input.room)?.[1];
 if (!input.candidate || !input.enabled || input.role!=='device' || !sn || !input.allowed.includes(sn))
  return {suppressOnboarding:false,instruction:''};
 return {suppressOnboarding:true,instruction:'当前会话支持独立后台搜索。你负责继续普通聊天，不能声称完全没有搜索能力，也不能编造已查到、已接单或已取消；这些由任务通道确认。用户只说帮我查一下却没给主题时，简短询问要查什么。不要自行声称正在发起查询。此测试会话使用隔离身份，不要主动反复询问姓名年龄，不推断或补造过去的个人记忆。'};
}

/** Ordinary LLM output has no execution authority. Task ACK/result speech bypasses
 * this endpoint. Buffer search-related sentences so split SSE tokens cannot leak
 * a promise before it is checked; unrelated production streams remain untouched. */
export function createSearchClaimFilter(enabled: boolean) {
 let pending = ''; let warned = false; let dropping = false;
 const fallback = () => {
  if (warned) return '';
  warned = true;
  return '要查询资料，请说“帮我查一下”，再加上具体问题。';
 };
 const inspect = (sentence: string): string => {
  const t = sentence.replace(/[\s，,：:]/g, '');
  if (/^[“‘"']/.test(t)) return sentence;
  const claim = /(?:我|小可)(?:现在|这就|马上|已经|刚刚|刚|正在|会|来|可以|能|帮你|替你|先|没有|没|还没|还没有|为你|帮您|去|在网上|上网|联网|试着){0,6}(?:查|搜)/.test(t)
   || /(?:正在|已经|还在|马上|这就)(?:为你|帮你)?(?:查|搜)/.test(t)
   || /^(?:好[的呀]?|嗯|刚才)?(?:查到|搜到|查完|搜完)/.test(t)
   || /(?:搜索|查询)(?:已经|已|正在|还没|没有)?(?:完成|开始|接单|取消|结束|失败)/.test(t)
   || /(?:我|小可)(?:来|会)?帮你看看/.test(t)
   || /^(?:稍等|请稍等|等我)[一下会儿哦呀啦]*[。！!？?]?$/.test(t);
  return claim ? fallback() : sentence;
 };
 return {
  feed(delta: string): string {
   if (!enabled) return delta;
   let out = '';
   for (const char of delta) {
    if (!dropping) pending += char;
    if (/[。！？!?\n]/.test(char)) {
     if (!dropping) out += inspect(pending);
     pending = ''; dropping = false;
    } else if (pending.length > 512) {
     // Bounded fail-closed sentence; never release a partial execution claim.
     out += fallback(); pending = ''; dropping = true;
    }
   }
   return out;
  },
  flush(): string {
   if (!enabled || dropping) { pending = ''; dropping = false; return ''; }
   const out = inspect(pending); pending = ''; return out;
  },
 };
}
