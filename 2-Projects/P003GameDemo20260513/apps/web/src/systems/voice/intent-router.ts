import type { VoiceIntent } from './response-schema';

/**
 * AI 语音意图路由（来自 3.2）
 *
 * 输入：用户 transcript
 * 输出：识别到的 intent + 关键 slots
 *
 * 路由表：
 * - 业务命令意图 → 直接触发对应 system（start_focus / open_box / ...）
 * - AI 子能力意图 → 转发给对应 intent handler（weather / encyclopedia / ...）
 * - chitchat → 进入闲聊模式（V1.5+ 接 LLM）
 * - unknown → 返回友好兜底
 *
 * V1.0 demo 仅做关键词匹配 + 业务命令分发。
 * V1.5+ 切到 LLM function calling，本模块的角色变为 prompt 注入。
 */

const COMMAND_PATTERNS: Array<{ pattern: RegExp; intent: VoiceIntent }> = [
  { pattern: /开始(学习|专注|探索|陪伴)|启航/, intent: 'start_focus' },
  { pattern: /(学完了|结束(探索|陪伴|专注)?|返舱|不学了)/, intent: 'end_focus' },
  { pattern: /(开箱|收获奖励|开宝箱)/, intent: 'open_box' },
  { pattern: /(换装|换皮肤|换造型|换模式)/, intent: 'change_skin' },
  { pattern: /(打开设置|开设置)/, intent: 'open_settings' },
  { pattern: /(关闭设置|关闭界面|关掉设置)/, intent: 'close_settings' },
  { pattern: /(开灯|关灯)/, intent: 'toggle_led' },
  { pattern: /(亮一点|暗一点|调亮|调暗)/, intent: 'adjust_brightness' },
  { pattern: /(声音(大|小)一点|调音量)/, intent: 'adjust_volume' },
];

const AI_PATTERNS: Array<{ pattern: RegExp; intent: VoiceIntent }> = [
  { pattern: /(天气|下雨|出门|穿什么|温度|气温)/, intent: 'weather_query' },
  { pattern: /(为什么|是什么|怎么(来|形成)|介绍一下)/, intent: 'encyclopedia_query' },
  { pattern: /(沸点|光年|公式|定理)/, intent: 'subject_question' },
  { pattern: /(讲(个|个)?故事|想听故事)/, intent: 'storytelling' },
];

export interface RoutedIntent {
  intent: VoiceIntent;
  slots: Record<string, unknown>;
  confidence: 'high' | 'low'; // 关键词命中=high，兜底=low
}

export function routeIntent(transcript: string): RoutedIntent {
  const text = transcript.trim();

  for (const { pattern, intent } of COMMAND_PATTERNS) {
    if (pattern.test(text)) return { intent, slots: {}, confidence: 'high' };
  }
  for (const { pattern, intent } of AI_PATTERNS) {
    if (pattern.test(text)) return { intent, slots: {}, confidence: 'high' };
  }

  // 兜底：闲聊或未知 —— V1.5+ 接 LLM 后此分支精度上来
  return { intent: 'chitchat', slots: { rawText: text }, confidence: 'low' };
}
