import type { ExpressionLabel } from '../services/expression-snapshot';

// neutral：给一个轻量中性思考音"嗯，"，让小可永远有"看到你"的人设感。
// 实测川哥自然状态 Gemini 一致判 neutral@0.95，原本空前缀 = 一直没表情前缀。
// 选"嗯，"而非"指挥官，"：现有字幕已 3/5 含"指挥官"，避免重复违和。
export const EXPR_INTRO: Record<ExpressionLabel, string> = {
  happy: '看你笑得这么开心，',
  tired: '今天看着有点累呢，',
  curious: '睁大眼睛在看什么？',
  neutral: '嗯，',
  no_face: '',
};

