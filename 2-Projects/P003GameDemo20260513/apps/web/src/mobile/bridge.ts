/**
 * P003 小可手机 App —— Web ↔ 原生 Android 壳 JS Bridge 契约（单一真源）
 *
 * 设计（team 四发共识 2026-06-19）：
 * - 唤醒词「小可小可」由原生 Porcupine 前台检测（WebView/WASM 后台会被 Chrome 挂起，做不了）。
 * - 麦克风互斥：原生 Porcupine 监听 与 Web getUserMedia 录音 不能同时占麦 →
 *   由 Web 侧状态机仲裁「谁拥有麦克风」，通过本 Bridge 协调。
 * - 优雅降级：普通手机浏览器（无原生壳）→ window.KidshubNative 不存在 →
 *   唤醒词不可用，UI 自动只显示 PTT（按住说话）。/m 页在纯浏览器也能跑。
 *
 * 原生侧由 grok/codex 按本契约实现（addJavascriptInterface 注入 KidshubNative，
 * evaluateJavascript 调用 KidshubWeb）。改本文件 = 改双方契约，必须同步原生实现。
 */

/** 原生壳注入到 window 的接口（Android addJavascriptInterface），Web 调用 */
export interface NativeBridge {
  /** 原生 Porcupine 是否就绪（模型加载 + AccessKey 授权成功）。无 key/初始化失败 → false */
  isWakeWordAvailable(): boolean;
  /** Web 请求原生开始唤醒监听（仅前台 idle 时；原生此时独占麦克风跑 Porcupine） */
  startWakeListening(): void;
  /** Web 请求原生暂停唤醒监听（PTT/对话录音前调用，原生释放麦克风让 Web getUserMedia 用） */
  pauseWakeListening(): void;
}

/** Web 注册到 window 的回调，原生通过 evaluateJavascript 调用 */
export interface WebBridge {
  /** 原生检测到「小可小可」时调用。约定：原生已先停自己的 Porcupine（释放麦克风）再调本回调 */
  onWakeWord(): void;
  /** 原生初始化完成回调（可选，告知唤醒能力，UI 据此决定是否显示唤醒提示） */
  onNativeReady(info: { wakeWordAvailable: boolean }): void;
}

declare global {
  interface Window {
    /** 原生注入（仅原生壳内存在；纯浏览器为 undefined → 降级 PTT-only） */
    KidshubNative?: NativeBridge;
    /** Web 注册（供原生 evaluateJavascript 调用） */
    KidshubWeb?: WebBridge;
  }
}

/** 是否运行在原生壳内（有唤醒词能力的前提） */
export function isNativeShell(): boolean {
  return typeof window !== 'undefined' && !!window.KidshubNative;
}

/** 原生唤醒词当前是否可用（壳内 + Porcupine 就绪）。任何异常一律按不可用降级 */
export function isWakeWordAvailable(): boolean {
  try {
    return isNativeShell() && !!window.KidshubNative?.isWakeWordAvailable();
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

/**
 * 注册 Web 侧回调（供原生调用）。返回注销函数。
 * onWakeWord：原生唤醒命中（原生已让出麦克风）→ Web 应立即进入录音对话。
 */
export function registerWebBridge(handlers: {
  onWakeWord: () => void;
  onNativeReady?: (info: { wakeWordAvailable: boolean }) => void;
}): () => void {
  if (typeof window === 'undefined') return () => {};
  const web: WebBridge = {
    onWakeWord: handlers.onWakeWord,
    onNativeReady: handlers.onNativeReady ?? (() => {}),
  };
  window.KidshubWeb = web;
  return () => {
    if (window.KidshubWeb === web) {
      delete window.KidshubWeb;
    }
  };
}
