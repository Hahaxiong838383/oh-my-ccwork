export interface TypewriterCallbacks {
  /** 每次打字推进时回调当前句的"已显示部分"（整句替换语义，调用方 setSubtitle 用） */
  onText(text: string): void;
  /** 收尾清空字幕 */
  onClear(): void;
}

export interface SubtitleTypewriter {
  feedText(delta: string): void;
  finalizeText(full: string): void;
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
  let clearTimer: number | null = null;
  let autoAdvanceTimer: number | null = null;

  function parseSentences(text: string): { closed: string[]; partial: string } {
    if (!text) return { closed: [], partial: '' };
    const enders = new Set(Array.from('。！？!?…'));
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

  function stopTypingTimer(): void {
    if (typingTimer !== null) {
      clearTimeout(typingTimer as any);
      typingTimer = null;
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
        cb.onText(txt.slice(0, currentTypedLen));
        typingTimer = setTimeout(doTick, charMs) as any;
      } else {
        typingTimer = null;
        maybeScheduleAutoAdvance();
      }
    };
    typingTimer = setTimeout(doTick, charMs) as any;
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
      cb.onText(txt.slice(0, showLen));
    }
    if (currentTypedLen < targetLen) {
      if (!typingTimer) {
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
        cb.onText(currTxt);
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
      cb.onText(currTxt);
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
