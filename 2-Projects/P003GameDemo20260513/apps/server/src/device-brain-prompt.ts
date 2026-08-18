import { deviceRegistryStore } from './device-registry-store.js';
import { assembleSystemPrompt } from './prompt-orchestrator.js';
import { ARK_WORLDVIEW_BASE } from './prompts.js';
import { AI_SAFETY_BASELINE } from './ai-literacy.js';
import type { AuthContext } from './auth-jwt.js';

/**
 * 设备 brain 的 per-device prompt 配置与分层组装（运营台 Worker Brain「编辑/拼接可视化」的数据层）。
 *
 * 同源铁律：custom-llm.ts 热路径与 admin 预览端点都从这里取 base/addendum——
 * 运营台看到的分层 = 设备真实收到的 systemPrompt（稳态部分），绝不各拼各的。
 * 安全边界：AI_SAFETY_BASELINE 不可被 per-device 配置移除/替换（儿童安全红线，常驻第 2 层）。
 * 降级安全：配置读取任何异常都回默认世界观，绝不阻断语音主链路。
 */

export type DevicePromptConfig = {
  worldview_override: string; // 空 = 用默认 ARK_WORLDVIEW_BASE
  prompt_addendum: string; // 空 = 关闭；非空拼接在 systemPrompt 最末
};

/**
 * per-device 身份路由（多设备防串号）：room=sn-<SN>-<ts> → registry 反查该设备的 brain 账号。
 * 语义：
 *  - token 无效（auth=null）→ 不路由（room 冒充无效，防公网伪造）；
 *  - room 非 sn- 设备房格式 → 原样返回 token 身份（Web 体验台/RTC 零影响）；
 *  - SN 在台账且已开通 brain → 该设备自己的账号（token 只当 worker 通行证）；
 *  - SN 未开通 brain / 不在台账 → null（匿名纯人设——绝不串到 token 兜底账号的记忆）。
 * 异常降级为原 token 身份，不阻断主链路。
 */
export function resolveDeviceIdentity(
  auth: AuthContext | null,
  room: string | undefined,
): AuthContext | null {
  if (!auth) return null;
  const m = /^sn-(BJP003\d{14})-\d+$/.exec((room ?? '').trim());
  if (!m) return auth;
  try {
    const device = deviceRegistryStore.get(m[1]!);
    if (device?.account_id) return { accountId: device.account_id, role: 'device' };
    return null;
  } catch {
    return auth;
  }
}

/** 按 brain 账号反查设备 prompt 配置；非设备账号（Web 家长）/异常 → null（走默认，零影响）。 */
export function getDevicePromptConfig(accountId: string): DevicePromptConfig | null {
  try {
    const device = deviceRegistryStore.findByAccountId(accountId);
    if (!device) return null;
    return {
      worldview_override: device.worldview_override ?? '',
      prompt_addendum: device.prompt_addendum ?? '',
    };
  } catch {
    return null;
  }
}

/** 稳态 base（第 1+2 层）：世界观（可 override）+ 安全基座（常驻不可编辑）。 */
export function buildDeviceBase(cfg: DevicePromptConfig | null): string {
  const worldview = cfg?.worldview_override?.trim() ? cfg.worldview_override.trim() : ARK_WORLDVIEW_BASE;
  return `${worldview}\n\n${AI_SAFETY_BASELINE}`;
}

/** addendum（最末层）：非空才拼；调用方负责拼接位置（systemPrompt 最末尾）。 */
export function deviceAddendum(cfg: DevicePromptConfig | null): string {
  return cfg?.prompt_addendum?.trim() ?? '';
}

export type PromptLayer = {
  key: string;
  label: string;
  source: string; // 内容来源说明（运营台展示）
  editable: boolean;
  text: string;
  chars: number;
};

/**
 * 分层视图（运营台拼接可视化）：与热路径同一组装路径跑一遍，再按已知结构切层。
 * 记忆区块用差分法取（assemble 返回 base + '\n\n' + 记忆区块，前缀剥掉即层 3）——
 * 不复制 prompt-orchestrator 内部逻辑，组装逻辑变了这里自动跟随。
 */
export function buildDeviceLayers(auth: AuthContext): { layers: PromptLayer[]; final: string } {
  const cfg = getDevicePromptConfig(auth.accountId);
  const worldviewText = cfg?.worldview_override?.trim() ? cfg.worldview_override.trim() : ARK_WORLDVIEW_BASE;
  const base = buildDeviceBase(cfg);
  // 预览不是真实注入：跳过 last_injected_at 回执，防「小可现在记着」高亮被管理查看稀释。
  const assembled = assembleSystemPrompt(base, null, auth, null, null, null, null, null, {
    skipInjectReceipt: true,
  });
  const memoryBlock = assembled.startsWith(base) ? assembled.slice(base.length).replace(/^\n+/, '') : '';
  const addendum = deviceAddendum(cfg);
  const final = addendum ? `${assembled}\n\n${addendum}` : assembled;

  const layers: PromptLayer[] = [
    {
      key: 'worldview',
      label: '世界观人设',
      source: cfg?.worldview_override?.trim() ? '本设备自定义（override）' : '默认 ARK_WORLDVIEW_BASE',
      editable: true,
      text: worldviewText,
      chars: worldviewText.length,
    },
    {
      key: 'safety',
      label: 'AI 安全基座',
      source: '常驻，不可编辑（儿童安全红线）',
      editable: false,
      text: AI_SAFETY_BASELINE,
      chars: AI_SAFETY_BASELINE.length,
    },
    {
      key: 'memory',
      label: '记忆区块（画像 + 情景记忆 + 使用规则）',
      source: '数据驱动——在「小可的记忆」里增删即变',
      editable: false,
      text: memoryBlock || '（该账号暂无画像/记忆，本层为空）',
      chars: memoryBlock.length,
    },
    {
      key: 'addendum',
      label: '附加规则',
      source: cfg?.prompt_addendum?.trim() ? '本设备自定义，拼接在最末' : '未启用（空 = 关闭）',
      editable: true,
      text: addendum || '（空）',
      chars: addendum.length,
    },
  ];
  return { layers, final };
}
