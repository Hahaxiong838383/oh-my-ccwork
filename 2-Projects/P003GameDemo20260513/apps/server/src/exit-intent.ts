/**
 * 退出意图识别（docs/25 问题3）—— 纯函数模块，无副作用，便于单测。
 *
 * 三层判退出中的 server 侧两层逻辑都在这里：
 *  - L1 告别词白名单 detectExitIntent(text)：对 ASR final 文本做整句匹配，~0ms。
 *    端侧（useMobileVoice）也独立跑同一规则，本函数供 server 兜底/对账（同一真相源思想）。
 *  - L2 [EXIT] 标记流式剥离 createExitMarkerStripper()：LLM 被要求在回复**开头**输出 [EXIT]
 *    表达「该结束对话了」。该标记绝不能进 TTS（合成出「左括号 EXIT」很怪），需从 llm.delta
 *    文本流里剥掉再喂 TTS；剥到则把本轮标记为退出轮。
 *
 * 设计要点：
 *  - L1 从严：只认「整句就是告别」或「告别词独立成句」，长句里偶含「再见」不误触发。
 *  - 严格排除裸否定 不要/不/我不（"我不要吃青菜" 必须放行），但带明确告别词的句子放行进退出。
 *  - 不可变：函数返回新值，stripper 用闭包私有 buffer，feed 返回新对象。
 */

// 告别词白名单（docs/25 + 川哥指定）。整句/独立短句匹配，不做子串模糊匹配。
// 说明：这里存的是「归一化后」（去标点、去空白）的告别短语。
const EXIT_PHRASES: readonly string[] = [
  '拜拜',
  '拜拜小可',
  '小可拜拜',
  '再见',
  '再见小可',
  '小可再见',
  '不聊了',
  '不想聊了',
  '不想聊',
  '不想跟你说了',
  '不想跟你说话了',
  '不想和你说了',
  '不想和你说话了',
  '别说了',
  '你别说了',
  '我走了',
  '我要走了',
  '我要走啦',
  '我去玩了',
  '我去玩啦',
  '我要去玩了',
  '我去睡觉了',
  '我要睡觉了',
  '我去睡了',
  '先这样',
  '先这样吧',
  '就这样吧',
  '不玩了',
  '我不玩了',
  '下次再聊',
  '下次聊',
  '我先走了',
  '我先走啦',
];

// 裸否定硬排除：仅当**整句归一化后**正好等于这些时，强制判定为「非退出」。
// 防 "不" 类被任何 startsWith/includes 规则误命中（"我不要吃青菜" 走 contains 也不该退）。
const BARE_NEGATIONS: ReadonlySet<string> = new Set([
  '不',
  '不要',
  '我不',
  '我不要',
  '不行',
  '不好',
  '不是',
  '不对',
  '我不想',
  '不知道',
  '不会',
]);

/**
 * 归一化：去掉首尾空白 + 所有标点/空格/语气修饰，便于整句比对。
 * 例 "拜拜~小可！" → "拜拜小可"；"我..要走啦。" → "我要走啦"。
 * 保留中英文与数字，其余（标点、空白、emoji）一律剔除。
 */
export function normalizeForExit(text: string): string {
  if (!text) return '';
  // 仅保留 CJK 统一表意文字 + 拉丁字母 + 数字；其余删除
  return text.replace(/[^一-龥a-zA-Z0-9]/g, '');
}

/**
 * L1 告别词白名单判定：text 是否表达「想结束对话」。
 * 规则（从严，避免长句误判）：
 *  1) 归一化后空串 → false。
 *  2) 归一化后正好是裸否定词（不要/我不…）→ false（即便后面规则可能命中也强制否）。
 *  3) 整句精确等于某告别短语 → true。
 *  4) 短句（归一化后 ≤ 8 字）里**包含**某告别短语 → true（容「嗯拜拜啦」「那再见咯」这类口语前后缀）。
 *     长句（> 8 字）只认精确相等，不做包含匹配（防"我跟你说再见面的时候"误触发）。
 * 返回布尔。纯函数。
 */
export function detectExitIntent(text: string): boolean {
  const norm = normalizeForExit(text);
  if (!norm) return false;
  if (BARE_NEGATIONS.has(norm)) return false;

  // 整句精确匹配
  for (const p of EXIT_PHRASES) {
    if (norm === p) return true;
  }

  // 短句包含匹配（仅 ≤ 8 字的短句，给口语语气词留余地）
  if (norm.length <= 8) {
    for (const p of EXIT_PHRASES) {
      if (norm.includes(p)) return true;
    }
  }
  return false;
}

// [EXIT] 标记的容错形态：大小写、全/半角方括号、首部空白都容忍。
// 仅在回复**开头**（去空白后）匹配一次。
const EXIT_MARKER_RE = /^\s*[【\[]\s*exit\s*[】\]]\s*/i;
// 流式时标记可能被切碎（先到 "[EX"），这是「可能是开头标记前缀」的判断：
// 去空白后是 "[" / "[e" / "[exi" … 这种 EXIT_MARKER_RE 的真前缀，需扣留等后续 delta。
const EXIT_MARKER_PARTIAL_RE = /^\s*[【\[](\s*e(x(i(t)?)?)?)?$/i;

export interface ExitMarkerResult {
  /** 剥掉 [EXIT] 后应放行进 llm.delta / TTS 的文本（可能为空） */
  text: string;
  /** 本 feed 是否首次识别到 [EXIT] 标记（一次性，仅命中那一刻为 true） */
  exit: boolean;
}

/**
 * 非流式整段剥离开头 [EXIT]（llm.done 的 fullText 用）。剥一次（标记只在开头），返回干净文本。
 * 与 stripExpressionTags 配合：先剥 EXIT 再剥表情。
 */
export function stripExitMarkerOnce(full: string): string {
  if (!full) return '';
  return full.replace(EXIT_MARKER_RE, '');
}

export interface ExitMarkerStripper {
  feed(delta: string): ExitMarkerResult;
  flush(): ExitMarkerResult;
  /** 整个流是否曾命中 [EXIT]（供 onDone 兜底读取） */
  hasExit(): boolean;
}

/**
 * 流式 [EXIT] 开头标记剥离器。
 * - 只在流的**最开头**找一次 [EXIT]（LLM 被要求放开头），命中即剥掉并置 exit=true。
 * - 标记可被任意 delta 切碎：开头疑似标记前缀时扣留 buffer，等后续 delta 拼齐再判。
 * - 一旦确认开头不是标记（出现非标记字符 / 扣留超阈值）→ 立即放行已扣留内容，之后零扣留直通。
 * - 与表情过滤器（expression-filter）解耦：表情过滤在本剥离之后再跑（标记在最前，先剥 EXIT）。
 */
export function createExitMarkerStripper(): ExitMarkerStripper {
  let buffer = '';
  let resolved = false; // 开头标记问题是否已定（命中或确认无标记）
  let exited = false;
  const MAX_PROBE = 16; // "[EXIT]" 最多 6 字符，留足容错空间

  const settleNoMarker = (): string => {
    resolved = true;
    const out = buffer;
    buffer = '';
    return out;
  };

  return {
    feed(delta: string): ExitMarkerResult {
      if (resolved) {
        // 开头已定：直通，零扣留
        return { text: delta, exit: false };
      }
      buffer += delta;
      const trimmedStart = buffer.replace(/^\s*/, '');
      if (trimmedStart === '') {
        // 全是空白，继续等
        return { text: '', exit: false };
      }

      // 完整命中开头标记 → 剥掉，标记之后的内容放行，开头问题定案
      const m = buffer.match(EXIT_MARKER_RE);
      if (m) {
        exited = true;
        resolved = true;
        const rest = buffer.slice(m[0].length);
        buffer = '';
        return { text: rest, exit: true };
      }

      // 可能是被切碎的标记前缀（"["/"[e"/"[exi"…）→ 扣留等后续，但超阈值放行防卡流
      if (EXIT_MARKER_PARTIAL_RE.test(buffer) && buffer.length <= MAX_PROBE) {
        return { text: '', exit: false };
      }

      // 开头不是 [EXIT]（首字符非 [ 或拼出来不像）→ 放行已扣留，之后直通
      return { text: settleNoMarker(), exit: false };
    },

    flush(): ExitMarkerResult {
      if (resolved || buffer === '') {
        const out = buffer;
        buffer = '';
        return { text: out, exit: false };
      }
      // 流结束仍未定：剩余的疑似前缀（如只发了 "["）当普通文本放行，不吞内容
      const out = buffer;
      buffer = '';
      resolved = true;
      return { text: out, exit: false };
    },

    hasExit(): boolean {
      return exited;
    },
  };
}
