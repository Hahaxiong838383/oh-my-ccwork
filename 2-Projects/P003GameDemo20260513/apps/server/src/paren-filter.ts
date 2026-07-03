/**
 * 括号旁白流式剥离器(2026-07-03,川哥反馈体验台实时对话念出"（挠了挠头）（开心地）"类状态机旁白)。
 *
 * prompt 禁令(addendum 第6条)是第一防线但压不死 LLM 自由发挥——本过滤器是 TTS 前的硬防线,
 * 与 expression-filter(剥【表情:x】)同族:接在 LLM 输出流上,custom-llm(RTC 双端)与 WS pipeline 共用。
 *
 * 剥离规则(防误杀,宁放勿吞):
 * - 只处理成对括号段:全角（…）与半角(…),允许开闭混用(LLM 常混打,如"(笑）")。
 * - 剥离条件 = 段完整闭合 && 内容含中文字符 && 内容 ≤40 字 —— 旁白必是中文短描述;
 *   纯数字/符号如 "(3+2)×5"、英文 "(ok)" 原样放行(不是旁白)。
 * - 跨 delta 切碎安全:遇开括号扣留缓冲,闭合时判定;缓冲超 60 字未闭合 → 判非旁白整段放行。
 * - 括号前已确认正文立即放行(最小 TTS 延迟);纯文本 delta 零扣留直通。
 * - flush:未闭合缓冲原样放行(绝不吞正文)。
 */

const OPEN = new Set(['（', '(']);
const CLOSE = new Set(['）', ')']);
const MAX_HOLD = 60; // 扣留上限(含括号):超过判非旁白放行
const MAX_ASIDE = 40; // 旁白内容上限:更长的括号段当正文放行
const CJK_RE = /[一-鿿]/;

export interface ParenFilter {
  feed(delta: string): string;
  flush(): string;
}

export function createParenFilter(): ParenFilter {
  let hold = ''; // 从开括号起扣留的缓冲(含开括号)

  const judge = (segment: string): string => {
    // segment = 完整 "（…）" 含两端括号。剥离(返回空串)或放行(原样返回)。
    const inner = segment.slice(1, -1);
    if (inner.length <= MAX_ASIDE && CJK_RE.test(inner)) return '';
    return segment;
  };

  return {
    feed(delta: string): string {
      if (!delta) return '';
      let out = '';
      for (const ch of delta) {
        if (hold) {
          hold += ch;
          if (CLOSE.has(ch)) {
            out += judge(hold);
            hold = '';
          } else if (OPEN.has(ch)) {
            // 括号未闭合又开新括号("（前段(新…"):前段判非旁白放行,从新开括号重新扣留
            out += hold.slice(0, -1);
            hold = ch;
          } else if (hold.length > MAX_HOLD) {
            out += hold; // 超限判非旁白,整段放行
            hold = '';
          }
        } else if (OPEN.has(ch)) {
          hold = ch;
        } else {
          out += ch;
        }
      }
      return out;
    },
    flush(): string {
      const rest = hold;
      hold = '';
      return rest; // 未闭合原样放行,绝不吞正文
    },
  };
}

/** 非流式一次性剥离(整段文本用,如 cue/日志清洗)。 */
export function stripParenAsides(text: string): string {
  const f = createParenFilter();
  return f.feed(text) + f.flush();
}
