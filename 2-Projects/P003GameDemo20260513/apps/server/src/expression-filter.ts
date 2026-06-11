/**
 * 表情标记流式过滤器（多标记句级版 B 阶段）
 *
 * - 流开头（第一个非空白内容）：容错双格式 /^\s*【\s*表情\s*[:：]\s*name\s*】 + 裸短【name】
 * - 句中（开头之后）：仅认标准【\s*表情\s*[:：]\s*name\s*】，裸【宝箱】等当正文原样放行
 * - 标记可任意 delta 切碎：滑动缓冲，遇【开始扣留，直到】或扣留段>40字判非标记放行
 * - 【之前已确认正文立即放行（最小 TTS 延迟）；纯文本 delta 零扣留直通
 * - flush：未闭合【表情：… 丢弃标记文本+尽力返回 name；其余未闭合原样放行
 * - 无 resolved 全局态，句中持续扫描；每次 match 用切片不共享 lastIndex
 */

const TAG_RE = /^\s*【\s*表情\s*[:：]\s*([^】]{1,16})\s*】\s*/;
const BARE_TAG_RE = /^\s*【\s*([^】:：]{1,10})\s*】\s*/;
const MAX_PROBE = 40;

export interface ExprStreamResult {
  text: string;
  expressions: string[];
}

export interface ExpressionFilter {
  feed(delta: string): ExprStreamResult;
  flush(): ExprStreamResult;
}

export function createExpressionFilter(): ExpressionFilter {
  let buffer = '';
  let atStart = true;

  const tryInitialTag = (s: string) => {
    const m = s.match(TAG_RE) ?? s.match(BARE_TAG_RE);
    if (!m) return null;
    return { consumed: m[0], expr: m[1].trim() };
  };

  const tryStdTag = (s: string) => {
    // anchored at current start (caller ensures starts with 【 for mid)
    const m = s.match(/^【\s*表情\s*[:：]\s*([^】]{1,16})\s*】\s*/);
    if (!m) return null;
    return { consumed: m[0], expr: m[1].trim() };
  };

  return {
    feed(delta: string): ExprStreamResult {
      if (!delta) return { text: '', expressions: [] };
      buffer += delta;

      let outText = '';
      const expressions: string[] = [];

      while (buffer.length > 0) {
        if (atStart) {
          const lead = buffer.replace(/^\s*/, '');
          if (lead.startsWith('【')) {
            // 初始机会：容错裸/标准
            const init = tryInitialTag(buffer);
            if (init) {
              expressions.push(init.expr);
              buffer = buffer.slice(init.consumed.length);
              atStart = false;
              continue;
            }
            if (lead.includes('】')) {
              outText += buffer;
              buffer = '';
              atStart = false;
              break;
            }
            if (lead.length > MAX_PROBE) {
              outText += buffer;
              buffer = '';
              atStart = false;
              break;
            }
            // 扣留初始标记
            break;
          }
          // atStart 但首非空白内容是正文 → 回落到通用逻辑（后续【仅标准）
        }

        // 通用：正文立即放行 + 句中仅标准标记探针（支持初始文本后跟句级标记）
        const openIdx = buffer.indexOf('【');
        if (openIdx === -1) {
          outText += buffer;
          if (atStart && /\S/.test(buffer)) atStart = false;
          buffer = '';
          break;
        }
        if (openIdx > 0) {
          const prefix = buffer.slice(0, openIdx);
          outText += prefix;
          buffer = buffer.slice(openIdx);
          if (atStart && /\S/.test(prefix)) atStart = false;
          continue;
        }

        // buffer 以 【 开头（句中或初始已过）
        const std = tryStdTag(buffer);
        if (std) {
          expressions.push(std.expr);
          buffer = buffer.slice(std.consumed.length);
          continue;
        }

        // 非标准【】块
        const closeIdx = buffer.indexOf('】');
        if (closeIdx !== -1) {
          const toRelease = buffer.slice(0, closeIdx + 1);
          outText += toRelease;
          buffer = buffer.slice(closeIdx + 1);
          continue;
        }

        if (buffer.length > MAX_PROBE) {
          outText += buffer;
          buffer = '';
          break;
        }

        // 扣留
        break;
      }

      return { text: outText, expressions };
    },

    flush(): ExprStreamResult {
      if (buffer.length === 0) return { text: '', expressions: [] };

      let outText = '';
      const expressions: string[] = [];

      let buf = buffer;
      let localAtStart = atStart;

      while (buf.length > 0) {
        if (localAtStart) {
          const init = tryInitialTag(buf);
          if (init) {
            expressions.push(init.expr);
            buf = buf.slice(init.consumed.length);
            localAtStart = false;
            continue;
          }
          const lead = buf.replace(/^\s*/, '');
          if (lead.startsWith('【')) {
            // flush 兜底 partial（标准优先 + 裸）
            const p = buf.match(/^\s*【\s*表情\s*[:：]\s*([^】]*)\s*$/) ??
                      buf.match(/^\s*【\s*([^】:：]{0,10})\s*$/);
            if (p) {
              const name = (p[1] || '').trim();
              if (name) expressions.push(name);
              buf = '';
              break;
            }
            // 非 partial 初始标记 → 放行（fallthrough 由后续 openIdx 处理）
          } else {
            // 初始文本后有句中标记 → fallthrough 通用 openIdx 逻辑
          }
        }

        const openIdx = buf.indexOf('【');
        if (openIdx === -1) {
          outText += buf;
          buf = '';
          break;
        }
        if (openIdx > 0) {
          const prefix = buf.slice(0, openIdx);
          outText += prefix;
          buf = buf.slice(openIdx);
          continue;
        }

        const std = tryStdTag(buf);
        if (std) {
          expressions.push(std.expr);
          buf = buf.slice(std.consumed.length);
          continue;
        }

        // flush partial 标准（句中未闭合【表情：xxx）
        const pstd = buf.match(/^【\s*表情\s*[:：]\s*([^】]*)\s*$/);
        if (pstd) {
          const name = (pstd[1] || '').trim();
          if (name) expressions.push(name);
          buf = '';
          break;
        }

        // 非 expr 部分 → 原样放行
        outText += buf;
        buf = '';
        break;
      }

      buffer = '';
      atStart = false;
      return { text: outText, expressions };
    },
  };
}

/** 非流式整段剥离（llm.done 的 fullText 用），剥全部标记，支持多标记 */
export function stripExpressionTags(full: string): ExprStreamResult {
  if (!full) return { text: '', expressions: [] };
  let text = full;
  const expressions: string[] = [];

  // 初始（容错裸）
  let m = text.match(TAG_RE) ?? text.match(BARE_TAG_RE);
  if (m) {
    expressions.push(m[1].trim());
    text = text.slice(m[0].length);
  }

  // 句中持续剥标准标记（用切片避免 lastIndex）
  while (true) {
    const idx = text.search(/【\s*表情\s*[:：]\s*[^】]{1,16}\s*】\s*/);
    if (idx === -1) break;
    const rest = text.slice(idx);
    const mm = rest.match(/^【\s*表情\s*[:：]\s*([^】]{1,16})\s*】\s*/);
    if (!mm) break;
    expressions.push(mm[1].trim());
    text = text.slice(0, idx) + text.slice(idx + mm[0].length);
  }

  return { text, expressions };
}
