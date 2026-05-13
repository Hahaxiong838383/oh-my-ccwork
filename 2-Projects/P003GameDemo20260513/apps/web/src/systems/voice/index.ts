// AI 语音陪伴 —— M4 milestone 实现
// Web Speech API（SpeechRecognition + SpeechSynthesis）
// 关键约束：所有语音指令必须有等效按钮 fallback（iOS Safari 支持不稳定）

export type VoiceCommand = 'start-focus' | 'end-focus' | 'open-box';

export function isVoiceSupported(): boolean {
  // @ts-expect-error webkit prefix
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function speak(text: string, lang = 'zh-CN'): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = 1.0;
  u.pitch = 1.05;
  window.speechSynthesis.speak(u);
}

// TODO M4: startListening / parseCommand / stopListening
