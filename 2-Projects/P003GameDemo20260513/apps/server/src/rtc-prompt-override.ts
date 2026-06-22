// 工作台「实时对话」双模式 prompt override（仿 feedback-arm 内存 Map + TTL 范式）。
//
// 火山 RTC 的 custom-llm 端点默认走固定小可大脑（世界观 + 记忆注入）。工作台调试时希望让
// RTC 对话用「右栏调好的 composed prompt」看真实效果——但火山进房后 SystemMessages 不可中途改。
// 破法：把 prompt 存在我方，StartVoiceChat 时把 roomId 透传进 custom-llm 回调 URL（?session=roomId），
// custom-llm 每轮回调按 roomId 取最新 override → 绕开火山中途换 prompt 的限制，
// 工作台改 prompt 调 setPromptOverride 覆盖即可，下一轮对话即时生效（无需重连）。
//
// 按 roomId 隔离并发；进程重启清空（调试态无需持久）。无 override = 降级回固定大脑（向后兼容手机端/体验台 live）。

const OVERRIDE_TTL_MS = 2 * 60 * 60 * 1000; // 2h：一局工作台调试对话足够；过期自动失效防内存泄漏。

type Entry = { systemPrompt: string; expireTs: number };
const store = new Map<string, Entry>();

/** 起 RTC / 工作台改 prompt → 存（覆盖）该房间的 systemPrompt override。 */
export function setPromptOverride(roomId: string, systemPrompt: string): void {
  if (!roomId || !systemPrompt.trim()) return;
  store.set(roomId, { systemPrompt, expireTs: Date.now() + OVERRIDE_TTL_MS });
}

/** custom-llm 回调按 roomId 取 override（每轮取最新→工作台改 prompt 即时生效）；无/过期返 null（降级固定大脑）。 */
export function getPromptOverride(roomId: string | undefined): string | null {
  if (!roomId) return null;
  const e = store.get(roomId);
  if (!e) return null;
  if (e.expireTs < Date.now()) {
    store.delete(roomId);
    return null;
  }
  return e.systemPrompt;
}

/** 离房清理（/stop 时调，及时释放；不调也会 TTL 过期兜底）。 */
export function clearPromptOverride(roomId: string | undefined): void {
  if (roomId) store.delete(roomId);
}
