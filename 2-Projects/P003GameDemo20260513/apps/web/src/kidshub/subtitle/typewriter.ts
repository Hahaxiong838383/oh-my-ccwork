export interface TypewriterCallbacks {
  /**
   * 每次打字推进时回调（累积语义，治视觉跳动）：
   * - committed = 本轮已说完的分句拼接（当前句之前的所有分句），调用方置灰
   * - active = 当前正在说的分句的已显示部分，调用方高亮
   * 调用方拼成「已说(灰)+当前(亮)」连续字幕，而非整行替换。
   */
  onText(committed: string, active: string): void;
  /** 收尾清空字幕 */
  onClear(): void;
}

export interface SubtitleTypewriter {
  feedText(delta: string): void;
  finalizeText(full: string): void;
  /** 切到下一句；传 durationMs(来自 tts.segment_start)则句内 rAF 铺满真实音频时长，否则固定 charMs */
  advanceSentence(durationMs?: number): void;
  finishPlayback(): void;
  reset(): void;
}

export function createSubtitleTypewriter(
  cb: TypewriterCallbacks,
  opts?: { charMs?: number; clearDelayMs?: number; autoAdvanceMs?: number },
): SubtitleTypewriter {
  // 固定每字时长。team 评审(2026-06-19)否定「上一句时长定当前句」的动态校准(固有滞后→临界跳)，
  // 回退固定值并调到略快于 volc TTS 中文语速(~200ms/字)留余量：让字幕略早于音频句打完、
  // 减少 advanceSentence 快进补完的跳跃。完整「字幕严格跟音频播放进度(rAF)」根治需 server 返
  // 句级时间戳(段≠句、句时长直到句末才知，前端架构限制) → 标 P2。durationMs 参数保留但已忽略。
  const charMs = Math.max(1, opts?.charMs ?? 150);
  const clearDelayMs = Math.max(0, opts?.clearDelayMs ?? 1200);
  // 自动跨句兜底：当前句打完后这么久没等到外部 advance（TTS 句边界信号与文本切句
  // 数不一致是常态：短句并段/逗号长句拆段），自动推进下一句——对齐降级但绝不卡死
  const autoAdvanceMs = Math.max(200, opts?.autoAdvanceMs ?? 1500);

  let rawText = '';
  let closed: string[] = [];
  let partial = '';
  let activeSentenceIdx = -1;
  let currentTypedLen = 0;

  let generation = 0;
  let typingTimer: number | null = null;
  let rafId: number | null = null;
  let clearTimer: number | null = null;
  let autoAdvanceTimer: number | null = null;
  // 当前句应铺满的真实音频时长(ms)，来自 tts.segment_start 的 durationMs。
  // 有值 → 句内用 rAF 按 elapsed/dur 平滑显现(锁真实语速，治"charMs 打完早→干等→猛跳")；
  // null(如开场白/无段时长) → 回退固定 charMs。
  let currentSentenceDurationMs: number | null = null;

  function parseSentences(text: string): { closed: string[]; partial: string } {
    if (!text) return { closed: [], partial: '' };
    // A(2026-06-19)：切句粒度对齐 server——Doubao-TTS 每个逗号/句号都发 sentence_break(→segment_start)，
    // 故逗号/顿号/分号也切「分句」。否则长句(一个句号含多逗号)只切 1 句，第 2 个 segment_start
    // (音频才播到句中)就触发 advanceSentence 快进补完整句 → 字幕超前 + 单行塞不下被省略。
    const enders = new Set(Array.from('。！？!?…，、；,;'));
    const closed: string[] = [];
    let start = 0;
    let i = 0;
    const n = text.length;
    while (i < n) {
      if (enders.has(text[i])) {
        let j = i + 1;
        while (j < n && enders.has(text[j])) j++;
        const sentence = text.slice(start, j);
        if (sentence.length > 0) {
          closed.push(sentence);
        }
        start = j;
        i = j;
      } else {
        i++;
      }
    }
    const partial = text.slice(start);
    return { closed, partial };
  }

  function reparse(): void {
    const res = parseSentences(rawText);
    closed = res.closed;
    partial = res.partial;
  }

  function getSentenceCount(): number {
    return closed.length + (partial ? 1 : 0);
  }

  function getSentenceText(idx: number): string {
    if (idx < closed.length) return closed[idx];
    if (idx === closed.length && partial) return partial;
    return '';
  }

  /** 当前句之前的所有分句拼接（已说完的累积，渲染层置灰）。activeSentenceIdx 之前必为 closed 分句。 */
  function committedText(): string {
    if (activeSentenceIdx <= 0) return '';
    const upto = Math.min(activeSentenceIdx, closed.length);
    return closed.slice(0, upto).join('');
  }

  /** 累积语义回调：committed=已说完(灰) + active=当前句已显示部分(亮) */
  function emitText(active: string): void {
    cb.onText(committedText(), active);
  }

  function stopTypingTimer(): void {
    if (typingTimer !== null) {
      clearTimeout(typingTimer as any);
      typingTimer = null;
    }
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function stopAutoAdvanceTimer(): void {
    if (autoAdvanceTimer !== null) {
      clearTimeout(autoAdvanceTimer as any);
      autoAdvanceTimer = null;
    }
  }

  /** 当前句已闭合打满且后面还有句 → 起兜底定时器自动推进（外部 advance 到达会取消重置） */
  function maybeScheduleAutoAdvance(): void {
    if (autoAdvanceTimer !== null) return;
    if (activeSentenceIdx < 0 || activeSentenceIdx >= closed.length) return; // 进行中句不兜底
    const txt = getSentenceText(activeSentenceIdx);
    if (currentTypedLen < txt.length) return;
    if (activeSentenceIdx + 1 >= getSentenceCount()) return; // 没有下一句
    const scheduledGen = generation;
    autoAdvanceTimer = setTimeout(() => {
      autoAdvanceTimer = null;
      if (generation !== scheduledGen) return;
      advanceSentence();
    }, autoAdvanceMs) as any;
  }

  function startTyping(): void {
    stopTypingTimer();
    const scheduledGen = generation;
    // 立即出首字(team 2026-06-19)：逐分句后每句开头等 charMs/帧会净滞后，先同步出第 1 字。
    {
      const txt0 = getSentenceText(activeSentenceIdx);
      if (txt0 && activeSentenceIdx >= 0 && currentTypedLen < 1) {
        currentTypedLen = 1;
        emitText(txt0.slice(0, 1));
        if (txt0.length <= 1) {
          maybeScheduleAutoAdvance();
          return;
        }
      }
    }

    // 模式 A — rAF 锁真实音频时长(2026-06-19)：句内按 elapsed/durationMs 平滑显现到这句字数，
    // 最后一字正好在本段音频播完(≈下一句 segment_start)时打完。治"固定 charMs 打完早→干等→猛跳"。
    if (currentSentenceDurationMs !== null && currentSentenceDurationMs > 0) {
      const dur = currentSentenceDurationMs;
      const startPerf = performance.now();
      const tick = () => {
        rafId = null;
        if (generation !== scheduledGen) return;
        const txt = getSentenceText(activeSentenceIdx);
        if (!txt || activeSentenceIdx < 0) return;
        const len = txt.length;
        const elapsed = performance.now() - startPerf;
        // 目标字数 = 这句字数 × 已播比例；单调不回退(只增)
        let target = Math.floor((elapsed / dur) * len);
        if (target > len) target = len;
        if (target > currentTypedLen) {
          currentTypedLen = target;
          emitText(txt.slice(0, currentTypedLen));
        }
        if (currentTypedLen < len) {
          rafId = requestAnimationFrame(tick);
        } else {
          maybeScheduleAutoAdvance();
        }
      };
      rafId = requestAnimationFrame(tick);
      return;
    }

    // 模式 B — 固定 charMs 回退(无段时长：开场白/sayDirect 等)
    const doTick = () => {
      if (generation !== scheduledGen) {
        typingTimer = null;
        return;
      }
      const txt = getSentenceText(activeSentenceIdx);
      if (!txt || activeSentenceIdx < 0) {
        typingTimer = null;
        return;
      }
      if (currentTypedLen < txt.length) {
        currentTypedLen++;
        emitText(txt.slice(0, currentTypedLen));
        typingTimer = setTimeout(doTick, charMs) as any;
      } else {
        typingTimer = null;
        maybeScheduleAutoAdvance();
      }
    };
    doTick();
  }

  function reconcileAfterTextUpdate(): void {
    if (activeSentenceIdx < 0) return;
    const total = getSentenceCount();
    if (activeSentenceIdx >= total) return;
    const txt = getSentenceText(activeSentenceIdx);
    const targetLen = txt.length;
    if (currentTypedLen > targetLen) {
      currentTypedLen = targetLen;
    }
    const showLen = Math.min(currentTypedLen, targetLen);
    currentTypedLen = showLen;
    if (showLen > 0) {
      emitText(txt.slice(0, showLen));
    }
    if (currentTypedLen < targetLen) {
      // rAF 模式下 tick 每帧动态读最新句文本，会自动吃进流式新增字；只有完全没在打时才重启
      if (typingTimer === null && rafId === null) {
        startTyping();
      }
    } else {
      // 文本更新后当前句已是打满状态（如 finalizeText 闭合了进行中句）→ 给兜底一个机会
      maybeScheduleAutoAdvance();
    }
  }

  function feedText(delta: string): void {
    if (!delta) return;
    rawText += delta;
    reparse();
    reconcileAfterTextUpdate();
  }

  function finalizeText(full: string): void {
    rawText = full || '';
    reparse();
    reconcileAfterTextUpdate();
  }

  function advanceSentence(durationMs?: number): void {
    // 外部句边界信号优先：取消在途的自动兜底，避免双推进跳句
    stopAutoAdvanceTimer();
    if (activeSentenceIdx >= 0) {
      const currTxt = getSentenceText(activeSentenceIdx);
      if (currentTypedLen < currTxt.length) {
        currentTypedLen = currTxt.length;
        emitText(currTxt);
      }
    }
    // 已在最后一句（外部信号比文本切句多：长句被 TTS 按逗号拆段）→ 原地不动，
    // 防 idx 越界后 reconcile 永久哑火
    if (activeSentenceIdx >= 0 && activeSentenceIdx + 1 >= getSentenceCount()) {
      return;
    }
    activeSentenceIdx = activeSentenceIdx + 1;
    if (activeSentenceIdx < 0) activeSentenceIdx = 0; // safety, though starts -1 +1 =0
    currentTypedLen = 0;
    // 本句铺满的真实音频时长(tts.segment_start.durationMs)；无则回退固定 charMs
    currentSentenceDurationMs = durationMs !== undefined && durationMs > 0 ? durationMs : null;
    stopTypingTimer();
    const newTxt = getSentenceText(activeSentenceIdx);
    if (newTxt.length > 0) {
      startTyping();
    }
    // else: pending, reconcile on future text will auto-start when available
  }

  function finishPlayback(): void {
    stopAutoAdvanceTimer();
    const total = getSentenceCount();
    if (activeSentenceIdx < 0 || total === 0) {
      // empty state (post-reset or no sentences): must no-op, never revive old content
      return;
    }
    // 播完时字幕应停在"最后说的那句"上：快进到最后一句并补完
    // （兜底/信号缺失导致中途卡住的句子直接跳过）
    stopTypingTimer();
    activeSentenceIdx = total - 1;
    const currTxt = getSentenceText(activeSentenceIdx);
    if (currentTypedLen !== currTxt.length) {
      currentTypedLen = currTxt.length;
      emitText(currTxt);
    }
    // schedule clear after delay (caller may have reset before this arrives in interrupt)
    if (clearTimer !== null) {
      clearTimeout(clearTimer as any);
    }
    const scheduledGen = generation;
    clearTimer = setTimeout(() => {
      if (generation !== scheduledGen) {
        clearTimer = null;
        return;
      }
      clearTimer = null;
      cb.onClear();
    }, clearDelayMs) as any;
  }

  function reset(): void {
    generation++;
    stopTypingTimer();
    stopAutoAdvanceTimer();
    if (clearTimer !== null) {
      clearTimeout(clearTimer as any);
      clearTimer = null;
    }
    rawText = '';
    closed = [];
    partial = '';
    activeSentenceIdx = -1;
    currentTypedLen = 0;
    currentSentenceDurationMs = null;
    // do NOT call onClear (caller decides subtitle clear to avoid double-clear races)
  }

  return {
    feedText,
    finalizeText,
    advanceSentence,
    finishPlayback,
    reset,
  };
}

/** module-level 单例：同 getSharedVoiceClient 模式，cb/opts 仅首次创建生效 */
let sharedInstance: SubtitleTypewriter | null = null;

export function getSharedTypewriter(
  cb: TypewriterCallbacks,
  opts?: { charMs?: number; clearDelayMs?: number; autoAdvanceMs?: number },
): SubtitleTypewriter {
  if (!sharedInstance) {
    sharedInstance = createSubtitleTypewriter(cb, opts);
  }
  return sharedInstance;
}

/** 仅测试用：清掉单例（让 unit test 之间互不污染），类似 voice-client */
export function __resetSharedTypewriterForTesting(): void {
  sharedInstance = null;
}
