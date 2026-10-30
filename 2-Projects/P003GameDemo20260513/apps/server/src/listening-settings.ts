import { validateDeviceSn } from './device-sn.js';
import type { ListeningSettings } from './listening-policy.js';
export const LISTENING_SCENES = ['story', 'sharing', 'singing'] as const;
export type ListeningScene = typeof LISTENING_SCENES[number];
export const LISTENING_FIELDS = [
  { key: 'max_session_sec', label: '最长倾听时间', unit: '秒', min: 300, max: 1800, default: 1800, hint: '达到上限后暂停，重新进入才能继续' },
  { key: 'feedback_max_chars', label: '反馈字数上限', unit: '字', min: 40, max: 160, default: 80, hint: '短反馈目标，不含普通衔接语' },
  { key: 'feedback_max_duration_sec', label: '反馈播放时长上限', unit: '秒', min: 5, max: 30, default: 12, hint: '达到时长后停止反馈，回到倾听' },
  { key: 'feedback_cooldown_sec', label: '两次反馈最短间隔', unit: '秒', min: 1, max: 30, default: 5, hint: '仅限制新反馈；停止和退出始终有效' },
  { key: 'summary_interval_sec', label: '摘要检查周期', unit: '秒', min: 60, max: 600, default: 180, hint: '周期或字数任一达到且有新增内容时，后台整理摘要' },
  { key: 'summary_trigger_chars', label: '摘要触发字数', unit: '字', min: 1000, max: 8000, default: 6000, hint: '累计未摘要内容达到阈值后触发，不阻塞收音' },
] as const;
export type ListeningTuning = Record<typeof LISTENING_FIELDS[number]['key'], number> & { voice_invitation_enabled: boolean };
export interface ListeningEditable { enabled: boolean; allowlist: string[]; scenes: ListeningScene[]; tuning: ListeningTuning }
export interface ListeningConfig extends ListeningEditable { schema_version: 1; revision: number }
export const LISTENING_FIXED = {
  lease_ttl_sec: 15, lease_refresh_sec: 5, revoke_target_sec: 16,
  raw_chars: 12000, recent_chars: 4000, summary_chars: 1200,
  singing_trigger: 'button_only', backchannel_enabled: false, auto_long_term_memory: false,
  per_frame_output_permit: true, feedback_returns_to_listening: true,
} as const;
export class ListeningConfigError extends Error {
  constructor(public code: string) { super(code); }
}
export function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function defaultListeningConfig(): ListeningConfig {
  return { schema_version: 1, revision: 1, enabled: false, allowlist: [], scenes: [...LISTENING_SCENES],
    tuning: { ...Object.fromEntries(LISTENING_FIELDS.map(f => [f.key, f.default])), voice_invitation_enabled: true } as ListeningTuning };
}
export function parseListeningEditable(value: unknown): ListeningEditable | null {
  if (!exactObject(value, ['enabled', 'allowlist', 'scenes', 'tuning']) || typeof value.enabled !== 'boolean'
      || !Array.isArray(value.allowlist) || value.allowlist.length > 1000
      || !Array.from(value.allowlist).every(sn => validateDeviceSn(sn).ok)
      || new Set(value.allowlist).size !== value.allowlist.length
      || !Array.isArray(value.scenes) || !value.scenes.length || value.scenes.length > 3
      || !Array.from(value.scenes).every(scene => LISTENING_SCENES.includes(scene))
      || new Set(value.scenes).size !== value.scenes.length
      || !exactObject(value.tuning, [...LISTENING_FIELDS.map(f => f.key), 'voice_invitation_enabled'])
      || typeof value.tuning.voice_invitation_enabled !== 'boolean') return null;
  const tuning = value.tuning;
  if (!LISTENING_FIELDS.every(f => Number.isInteger(tuning[f.key]) && (tuning[f.key] as number) >= f.min && (tuning[f.key] as number) <= f.max)) return null;
  return structuredClone(value) as unknown as ListeningEditable;
}
export function parseListeningConfig(value: unknown): ListeningConfig | null {
  if (!exactObject(value, ['schema_version','revision','enabled','allowlist','scenes','tuning'])
      || value.schema_version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return null;
  const { schema_version, revision, ...editable } = value;
  const parsed = parseListeningEditable(editable);
  return parsed ? { ...parsed, schema_version: 1, revision: revision as number } : null;
}
/** Lease/session integration must consume this same revision and its tuning snapshot. */
export function listeningPolicyFromConfig(config: ListeningConfig): ListeningSettings {
  return { version: config.revision, enabled: config.enabled, allowlist: [...config.allowlist] };
}
export function listeningRuntimeStatus() {
  // There is deliberately no env/UI override claiming a Worker has applied this configuration.
  // Replace with authoritative readiness + acknowledgement evidence during runtime integration.
  return { status: 'not_integrated', ready: false, effective_enabled: false,
    applied_revision: null, active_sessions: null, last_ack_at: null,
    message: '倾听运行链路尚未接入；可预先保存参数，当前不能开启总闸。',
    parameter_effect: '接入后，新进入的倾听会话使用参数快照；关闭总闸、移出名单或禁用场景经短租约撤权。' };
}
