/**
 * 表情标记流式过滤器 —— 从 LLM 输出流开头解析【表情：xxx】并剥离
 *
 * 为什么在 server 做：标记必须在喂 TTS 之前剥掉（否则小可会把"表情：开心跳起"念出来），
 * 而 LLM 流式输出标记可能被切碎在多个 delta 里（如「【表」+「情：比心】今天…」），
 * 只能带缓冲地流式解析。剥离后 client 的 llm.delta / 字幕 / TTS 全部拿到干净正文。
 *
 * 缓冲策略（最小化 TTFT 损耗）：
 *  - 只在回复以可选空白 + 「【」开头时才缓冲；首字符不是「【」立即放行
 *  - 见到「】」：是表情标记 → 解析+剥离；是别的【…】→ 原样放行
 *  - 缓冲超 MAX_PROBE 还没闭合 → 判定不是标记，全部放行（防 LLM 异常输出卡流）
 */

// 标准格式【表情：名字】+ 容错格式【名字】（temperature 1.0 下 LLM 实测会偷懒省掉
// "表情："前缀；addendum 已规定正文不得再出现【】，开头裸短标记按表情尝试是安全的——
// 名字解析不出来时前端只记一条"未识别"调试日志，不影响正文）
const TAG_RE = /^\s*【\s*表情\s*[:：]\s*([^】]{1,16})\s*】\s*/;
const BARE_TAG_RE = /^\s*【\s*([^】:：]{1,10})\s*】\s*/;
const MAX_PROBE = 40;

export interface ExprFeedResult {
  /** 应继续下发/喂 TTS 的正文（可能为空串 = 还在缓冲） */
  text: string;
  /** 解析到的表情名（仅解析成功那一次带） */
  expression?: string;
}

export interface ExpressionFilter {
  feed(delta: string): ExprFeedResult;
  /** 流结束兜底：缓冲里若是完整标记仍解析，否则原样放行 */
  flush(): ExprFeedResult;
}

export function createExpressionFilter(): ExpressionFilter {
  let buf = '';
  let resolved = false;

  const release = (): ExprFeedResult => {
    resolved = true;
    const out = buf;
    buf = '';
    return { text: out };
  };

  const tryParse = (): ExprFeedResult | null => {
    const m = buf.match(TAG_RE) ?? buf.match(BARE_TAG_RE);
    if (!m) return null;
    resolved = true;
    const rest = buf.slice(m[0].length);
    buf = '';
    return { text: rest, expression: m[1].trim() };
  };

  return {
    feed(delta: string): ExprFeedResult {
      if (resolved) return { text: delta };
      buf += delta;
      const lead = buf.replace(/^\s*/, '');
      if (lead.length === 0) return { text: '' };
      if (!lead.startsWith('【')) return release();

      const parsed = tryParse();
      if (parsed) return parsed;
      // 有闭合括号但不是表情标记（LLM 用【】说别的）→ 原样放行
      if (lead.includes('】')) return release();
      if (lead.length > MAX_PROBE) return release();
      return { text: '' };
    },

    flush(): ExprFeedResult {
      if (resolved || buf.length === 0) return { text: '' };
      const parsed = tryParse();
      if (parsed) return parsed;
      // 未闭合但确定是表情标记开头（LLM 截断）→ 丢弃标记文本（不能让 TTS 念"表情："），
      // 名字部分尽力返回（client 端 resolveExpressionName 会模糊匹配）
      const partial = buf.match(/^\s*【\s*表情\s*[:：]\s*([^】]*)\s*$/);
      if (partial) {
        resolved = true;
        buf = '';
        const name = partial[1].trim();
        return name ? { text: '', expression: name } : { text: '' };
      }
      return release();
    },
  };
}

/** 非流式整段剥离（llm.done 的 fullText 用） */
export function stripExpressionTag(full: string): ExprFeedResult {
  const m = full.match(TAG_RE) ?? full.match(BARE_TAG_RE);
  if (!m) return { text: full };
  return { text: full.slice(m[0].length), expression: m[1].trim() };
}
