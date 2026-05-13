import { z } from 'zod';

/**
 * 语音对话响应结构（来自 3.8）
 *
 * MCP + function calling 让大模型输出结构化结果：
 *   不只是纯文本，还附带 action（动作）/ emotion（表情）/ intent（意图）
 *
 * 前端 xiaoke 状态机直接消费 action/emotion 播放对应动画。
 *
 * V1.0 demo 即使用按钮 fallback，所有"小可说话"出口也要按此结构走，
 * 未来接 LLM 时零改造。
 */

export const xiaokeAnimSchema = z.enum([
  // 待机/动作
  'idle_wave', 'idle_spin', 'idle_nod', 'walk', 'read_book',
  // 反应
  'cheer', 'happy', 'curious', 'sad', 'comforting',
  // 特殊
  'wake_greet', 'farewell', 'thinking',
]);

export const xiaokeEmotionSchema = z.enum([
  'happy', 'curious', 'warm', 'excited', 'calm', 'sad',
]);

export const voiceIntentSchema = z.enum([
  // 业务意图（直接触发对应 system）
  'start_focus', 'end_focus', 'open_box',
  'change_skin', 'change_personality',
  'open_settings', 'close_settings',
  'toggle_led', 'adjust_brightness', 'adjust_color_temp', 'adjust_volume',
  // AI 子能力意图（路由到 intent router）
  'weather_query', 'encyclopedia_query', 'subject_question',
  'storytelling', 'avg_game', 'programming',
  // 其他
  'chitchat', 'unknown',
]);

export const voiceResponseSchema = z.object({
  text: z.string(),
  voiceId: z.number().int().optional(),
  action: xiaokeAnimSchema.optional(),
  emotion: xiaokeEmotionSchema.optional(),
  intent: voiceIntentSchema.optional(),
  intentSlots: z.record(z.string(), z.unknown()).optional(), // 比如 weather_query 的 {location, time}
});

export type XiaokeAnim = z.infer<typeof xiaokeAnimSchema>;
export type XiaokeEmotion = z.infer<typeof xiaokeEmotionSchema>;
export type VoiceIntent = z.infer<typeof voiceIntentSchema>;
export type VoiceResponse = z.infer<typeof voiceResponseSchema>;
