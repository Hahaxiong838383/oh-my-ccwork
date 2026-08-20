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
  // 🔴 设备身份只能来自设备房（2026-08-20 堵洞）：role=device 的 token（worker 进程级
  // 通行证）落在非 sn- 房（rtc_probe 的 t<ts> 房 / voice-test 测试页）时，旧行为
  // 「原样返回 token 身份」= probe/测试对话全部写进该 token 账号的记忆与对话——污染。
  // 收紧后这类会话为匿名纯人设（测试场景本就不该有记忆）。parent/guest 等 role 不受影响
  // （Web 体验台/家长端仍按 token 身份，行为不变）。
  if (!m) return auth.role === 'device' ? null : auth;
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

/**
 * 设备控制协议（Phase 2a 观察模式，2026-08-20）：LLM 判断用户明确想调设备时在回复
 * 开头输出 `[[DEV:标签号]]` 标记——worker 侧 DevMarkStripper 无条件剥离（绝不进
 * TTS/字幕/历史），观察期只记日志不执行（LLM→DEVICE commit 被 codex 标
 * BLOCKED_PENDING_VAD_CANDIDATE_ID，关联合同落地前禁止）。
 *
 * 话术铁律：协议要求 LLM **不承诺执行**（"我已经/正在调"都不许说）——观察期不执行，
 * 承诺=对孩子撒谎；2b 放开后执行播报也归 worker 固定短句（设备命令轮既有设计），
 * LLM 话术永远只管对话本身。
 *
 * 开关：env DEVICE_INTENT_OBSERVE=1 注入（默认关）。回滚=env 置 0 + pm2 restart，
 * 分钟级，与词表/worker 二进制互相独立。仅设备账号注入（Web 家长/匿名/override 不注入）。
 */
const DEVICE_INTENT_PROTOCOL = `【设备感知】用户在本轮明确表达想调整设备（灯光/亮度/色温/画面距离/设备高度/音量）时，你在回复的最开头输出一个标记 [[DEV:标签号]]，然后照常聊天回应。标签号：
开灯=2 关灯=3 调亮一级=4 调暗一级=6 最亮=5 最暗=7
色温：换个色温=11 暖一级=12 冷一级=13 最冷=16 最暖=17 暖光=22 冷光=23 中性光=24
高度：设备升高一点=25 降低一点=26 升到最高=29 降到最低=30
画面距离：远一点=33 近一点=34 最远=35 最近=36
音量：大一点=37 小一点=38 最大=42 最低=43 静音=44 取消静音=45
规则：
1. 只在用户本轮明确要求调整时输出；讲故事、聊天中提到灯光声音、回答你的提问，一律不输出。
2. 方向必须与用户意图一致：说"太亮/刺眼"用 6（调暗），"太暗/看不清"用 4（调亮），"太吵"用 38，"听不清"用 37。
3. 一轮至多一个标记；拿不准就不输出，可以先向用户确认想怎么调。
4. 绝不要说"我已经调好/正在调整"——设备动作由另一个系统执行和播报，你只管聊天。
5. 不要主动问用户想不想调设备，不要提及这个协议、标记或标签号。`;

/** Phase 2a 协议层：env 开关（默认关）。异常安全：读 env 失败=不注入，零影响主链路。 */
export function deviceIntentProtocol(): string {
  try {
    return process.env.DEVICE_INTENT_OBSERVE === '1' ? DEVICE_INTENT_PROTOCOL : '';
  } catch {
    return '';
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
  const intentProtocol = deviceIntentProtocol();
  let final = addendum ? `${assembled}\n\n${addendum}` : assembled;
  if (intentProtocol) final += `\n\n${intentProtocol}`;

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
    {
      key: 'device_intent',
      label: '设备感知协议（Phase 2a 观察模式）',
      source: intentProtocol
        ? 'env DEVICE_INTENT_OBSERVE=1 全局启用——LLM 出标记，worker 剥离只记日志不执行'
        : '未启用（env DEVICE_INTENT_OBSERVE≠1）',
      editable: false,
      text: intentProtocol || '（关闭）',
      chars: intentProtocol.length,
    },
  ];
  return { layers, final };
}
