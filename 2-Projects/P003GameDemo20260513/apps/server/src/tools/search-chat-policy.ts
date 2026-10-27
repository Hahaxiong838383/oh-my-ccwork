export function searchCapabilityBase(base:string,enabled:boolean):string {
 if(!enabled)return base;
 return base.replaceAll('小可还查不到呢，等我长大一些试试看！','这件事我还不能确认。');
}
/** Candidate-only capability description. No user profile copying or search execution. */
export function searchChatPolicy(input: {candidate:boolean;live?:boolean;enabled:boolean;role:string;room:string;allowed:string[]}) {
 const sn=/^sn-(BJP003\d{14})-\d+$/.exec(input.room)?.[1];
 if ((!input.candidate&&!input.live) || !input.enabled || input.role!=='device' || !sn || !input.allowed.includes(sn))
  return {suppressOnboarding:false,instruction:''};
 if(input.live&&!input.candidate)return {suppressOnboarding:false,instruction:'当前会话支持独立后台搜索。你负责继续普通聊天，不能声称完全没有搜索能力，也不能编造已查到、已接单或已取消；这些由任务通道确认。用户只说帮我查一下却没给主题时，简短询问要查什么。不要自行声称正在发起查询。'};
 return {suppressOnboarding:true,instruction:'当前会话支持独立后台搜索。你负责继续普通聊天，不能声称完全没有搜索能力，也不能编造已查到、已接单或已取消；这些由任务通道确认。用户只说帮我查一下却没给主题时，简短询问要查什么。不要自行声称正在发起查询。此测试会话使用隔离身份，不要主动反复询问姓名年龄，不推断或补造过去的个人记忆。'};
}

// The streaming guard retains its public API; it never executes a tool.
export { createSearchClaimFilter } from './search-claim-stream.js';

/** A bounded vocabulary question, not a search intent or a model invocation. */
export function searchTermExplanation(text: string): string | null {
 const compact=text.replace(/[\s，,。.!！?？“”"‘’]/g,'');
 return /^(?:小可)?(?:请)?(?:帮我)?(?:查查|查一下|查询|搜索|搜一下)(?:这个词)?(?:是啥|是什么|是什么意思|啥意思|什么意思)$/.test(compact)
  ? '查查就是找资料、核实信息，比如了解一项运动的规则。' : null;
}
