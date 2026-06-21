/**
 * P003 小可手机 App —— Web ↔ 原生 Android 壳 JS Bridge 契约（单一真源）
 *
 * 设计（team 四发共识 2026-06-19，P1/P2 端侧 ASR 扩展 2026-06-21）：
 * - 唤醒词「小可小可」由原生 KeywordSpotter 前台检测（WebView/WASM 后台会被 Chrome 挂起，做不了）。
 * - 端侧 ASR：原生 AudioEngine（单一 AudioRecord + sherpa OnlineRecognizer）流式识别，
 *   partial/endpoint/final 经本 Bridge 回调喂 Web；Web 把 final 走 chat.trigger 入 LLM（server 近零改）。
 * - 麦克风互斥：原生独占麦克风（KWS + ASR 共用单 AudioRecord），Web 不再 getUserMedia（端侧模式）。
 * - 优雅降级：普通手机浏览器（无原生壳）→ window.KidshubNative 不存在 →
 *   唤醒/端侧 ASR 不可用，UI 自动只显示 PTT，ASR 回退云火山。/m 页在纯浏览器也能跑。
 *
 * 原生侧由 AudioEngine/AsrBridge 实现（addJavascriptInterface 注入 KidshubNative，
 * evaluateJavascript 调用 KidshubWeb）。改本文件 = 改双方契约，必须同步原生实现。
 */

/** 原生壳注入到 window 的接口（Android addJavascriptInterface），Web 调用 */
export interface NativeBridge {
  /** 原生唤醒词是否就绪（模型加载成功）。无/失败 → false */
  isWakeWordAvailable(): boolean;
  /** Web 请求原生开始唤醒监听（idle 时；原生独占麦克风跑 KWS） */
  startWakeListening(): void;
  /** Web 请求原生暂停唤醒监听（原生释放麦克风/停录音线程） */
  pauseWakeListening(): void;

  // ==================== P2 端侧 ASR（P1 AudioEngine 已实现，注入名仍 KidshubNative） ====================
  /** 端侧 ASR 是否就绪（OnlineRecognizer init 成功）。false → Web 回退云火山 */
  isOnDeviceAsrAvailable(): boolean;
  /** 开始端侧 ASR。mode='auto'(endpoint 自动判停) | 'ptt'(松手 stopAsr 收尾) */
  startAsr(mode: string): void;
  /** 停止端侧 ASR（PTT 松手 / 打断） */
  stopAsr(): void;
  /** 通知原生 TTS 播放态：true=播放中（原生静音 ASR 防自激）/ false=结束（延迟恢复） */
  notifyTtsState(speaking: boolean): void;
}

/** Web 注册到 window 的回调，原生通过 evaluateJavascript 调用 */
export interface WebBridge {
  /** 原生检测到「小可小可」时调用（原生已先停 KWS 释放麦克风再调） */
  onWakeWord(): void;
  /** 原生初始化完成回调（告知唤醒/端侧 ASR 能力，UI 据此决定走端侧还是云） */
  onNativeReady(info: { wakeWordAvailable: boolean; onDeviceAsrAvailable?: boolean }): void;

  // ==================== P2 端侧 ASR 回调 ====================
  /** 端侧 ASR 流式 partial（逐字字幕）。已在原生侧节流（≥120ms + 变化才推） */
  onAsrPartial(text: string): void;
  /** 端侧 ASR endpoint 判停命中（auto 模式：该收尾本轮录音） */
  onAsrEndpoint(): void;
  /** 端侧 ASR 整句最终文本（Web 据此走 chat.trigger 入 LLM） */
  onAsrFinal(text: string): void;
}

declare global {
  interface Window {
    /** 原生注入（仅原生壳内存在；纯浏览器为 undefined → 降级 PTT-only + 云 ASR） */
    KidshubNative?: NativeBridge;
    /** Web 注册（供原生 evaluateJavascript 调用） */
    KidshubWeb?: WebBridge;
  }
}

/** 是否运行在原生壳内（有唤醒词/端侧 ASR 能力的前提） */
export function isNativeShell(): boolean {
  return typeof window !== 'undefined' && !!window.KidshubNative;
}

/** 原生唤醒词当前是否可用（壳内 + KWS 就绪）。任何异常一律按不可用降级 */
export function isWakeWordAvailable(): boolean {
  try {
    return isNativeShell() && !!window.KidshubNative?.isWakeWordAvailable();
  } catch {
    return false;
  }
}

/** 端侧 ASR 当前是否可用（壳内 + OnlineRecognizer 就绪）。异常按不可用降级（→ 回退云火山） */
export function isOnDeviceAsrAvailable(): boolean {
  try {
    return isNativeShell() && !!window.KidshubNative?.isOnDeviceAsrAvailable?.();
  } catch {
    return false;
  }
}

/** Web 请求原生开始唤醒监听（best-effort；无壳静默 no-op） */
export function startWakeListening(): void {
  try {
    window.KidshubNative?.startWakeListening();
  } catch {
    /* 无壳或原生异常：静默，纯浏览器靠 PTT */
  }
}

/** Web 请求原生暂停唤醒监听（best-effort；录音前调用避免抢麦） */
export function pauseWakeListening(): void {
  try {
    window.KidshubNative?.pauseWakeListening();
  } catch {
    /* 同上 */
  }
}

/** 开始端侧 ASR（best-effort；无壳/不可用静默 no-op） */
export function startAsr(mode: 'auto' | 'ptt'): void {
  try {
    window.KidshubNative?.startAsr?.(mode);
  } catch {
    /* 无壳或原生异常：静默 */
  }
}

/** 停止端侧 ASR（best-effort） */
export function stopAsr(): void {
  try {
    window.KidshubNative?.stopAsr?.();
  } catch {
    /* 静默 */
  }
}

/** 通知原生 TTS 播放态（AEC：原生据此静音 ASR 防自激）。best-effort */
export function notifyTtsState(speaking: boolean): void {
  try {
    window.KidshubNative?.notifyTtsState?.(speaking);
  } catch {
    /* 静默 */
  }
}

/**
 * 注册 Web 侧回调（供原生调用）。返回注销函数。
 * - onWakeWord：原生唤醒命中（原生已让出麦克风）→ Web 进入录音对话。
 * - onAsrPartial/Endpoint/Final：端侧 ASR 流式结果（P2）。
 */
export function registerWebBridge(handlers: {
  onWakeWord: () => void;
  onNativeReady?: (info: { wakeWordAvailable: boolean; onDeviceAsrAvailable?: boolean }) => void;
  onAsrPartial?: (text: string) => void;
  onAsrEndpoint?: () => void;
  onAsrFinal?: (text: string) => void;
}): () => void {
  if (typeof window === 'undefined') return () => {};
  const web: WebBridge = {
    onWakeWord: handlers.onWakeWord,
    onNativeReady: handlers.onNativeReady ?? (() => {}),
    onAsrPartial: handlers.onAsrPartial ?? (() => {}),
    onAsrEndpoint: handlers.onAsrEndpoint ?? (() => {}),
    onAsrFinal: handlers.onAsrFinal ?? (() => {}),
  };
  window.KidshubWeb = web;
  return () => {
    if (window.KidshubWeb === web) {
      delete window.KidshubWeb;
    }
  };
}
