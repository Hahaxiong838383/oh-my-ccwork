import type { ExpressionLabel } from '../services/expression-snapshot';

// D6 P1 V3：12 标签前缀（删 neutral），川哥要"每次都有表情前缀"。
// 设计原则同 V2：4-12 字、不重复"指挥官"、拟人不卖萌过头。
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
  // 认知 / 思考
  curious: '睁大眼睛在看什么？',
  focused: '看你这么专注，',
  surprised: '哇，吓一跳吧？',
  thinking: '在想什么呢？',
  // 兜底（无脸时回退 V0.9 原字幕）
  no_face: '',
};

