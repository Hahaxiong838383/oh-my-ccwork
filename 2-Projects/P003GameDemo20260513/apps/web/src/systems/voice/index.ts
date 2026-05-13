/**
 * 语音对话（来自 1.9）
 *
 * 唤醒词：小可小可 / 你好小可 / 爱视可
 * 命令集（demo 子集）：开始学习 / 结束探索 / 开箱 / 给小可换装 / 关闭设置
 * 二次确认场景：结束专注（必须 30s 内确认）
 *
 * iOS Safari 限制：Web Speech API 不稳定，所有命令必须有按钮 fallback
 */

const WAKE_WORDS = ['小可小可', '你好小可', '爱视可'];

export function isVoiceSupported(): boolean {
  if (typeof window === 'undefined') return false;
  // @ts-expect-error webkit prefix
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function speak(text: string, lang = 'zh-CN'): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = 1.0;
  u.pitch = 1.05;
  window.speechSynthesis.speak(u);
}

export function isWakeWord(transcript: string): boolean {
  const normalized = transcript.trim().replace(/\s+/g, '');
  return WAKE_WORDS.some((w) => normalized.includes(w));
}

// TODO M6: VAD / 唤醒后 listening / 命令解析 / 二次确认
