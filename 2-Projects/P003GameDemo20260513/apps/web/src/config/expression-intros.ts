import type { ExpressionLabel } from '../services/expression-snapshot';

// D6 P1 V2：扩到 13 标签，川哥要"越丰富越好"。每个前缀短而有人设感。
// 设计原则：
// 1. 不重复字幕已有词（"指挥官"已在 3/5 字幕）
// 2. 4-12 字范围，TTS 合成 < 0.4s
// 3. 拟人但不卖萌过头（demo 是儿童陪伴 K1 飞船设定）
// 4. neutral / no_face 仍保最轻量（自然/无脸时不抢戏）
export const EXPR_INTRO: Record<ExpressionLabel, string> = {
  // 正向
  happy: '看你笑得这么开心，',
  excited: '看你这么期待，',
  // 负向
  sad: '别难过，小可陪你，',
  tired: '今天看着有点累呢，',
  bored: '有点没精神？',
  confused: '有点疑惑？小可帮你想想，',
  shy: '别害羞嘛，',
  // 认知 / 中性
  curious: '睁大眼睛在看什么？',
  focused: '看你这么专注，',
  surprised: '哇，吓一跳吧？',
  thinking: '在想什么呢？',
  neutral: '嗯，',
  // 兜底
  no_face: '',
};

