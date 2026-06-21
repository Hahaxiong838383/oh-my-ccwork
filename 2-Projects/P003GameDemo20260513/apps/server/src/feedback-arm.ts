// 吐槽 arm 通道（手机端火山 RTC 用）。
// RTC 全双工没有端侧 app「按住录音」的 captureMode 下发通道，改用「预置(arm)」范式：
//   前端点「我要吐槽」→ POST /api/rtc/feedback-arm 标记该 accountId 进入吐槽模式（一轮）；
//   custom-llm 回调时 consume → 命中则落反馈库 + 切吐槽人格，一次性消费 + TTL 兜底(防点了不说话永久挂着)。
// 纯内存 Map（进程级，重启清空——吐槽是即时行为，无需持久）。按 accountId 隔离并发，匿名(无 accountId)不支持吐槽。

const ARM_TTL_MS = 60_000; // arm 后 60s 内的下一轮算吐槽，超时自动失效（防点了不说话永久挂着影响下次正常对话）。

const armed = new Map<string, number>(); // accountId → expireTs

/** 前端点吐槽 → 标记该 accountId 进入吐槽模式（一轮，TTL 兜底）。 */
export function armFeedback(accountId: string): void {
  armed.set(accountId, Date.now() + ARM_TTL_MS);
}

/**
 * custom-llm 回调时消费：存在且未过期 → 返回 true（本轮走吐槽），并清除（一次性，只命中下一轮）；
 * 不存在或已过期 → 返回 false（正常对话）。无论命中与否，过期/命中项都会被清除。
 */
export function consumeFeedbackArmed(accountId: string): boolean {
  const exp = armed.get(accountId);
  if (exp === undefined) return false;
  armed.delete(accountId); // 一次性消费
  return exp > Date.now();
}
