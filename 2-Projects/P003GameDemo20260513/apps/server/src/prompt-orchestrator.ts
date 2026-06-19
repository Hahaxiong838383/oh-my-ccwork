import { profileStore } from './profile-store.js';
import type { AuthContext } from './auth-jwt.js';

// P0.2 后端 Prompt Orchestrator：记忆只在后端汇入 systemPrompt（端无关、可即时剔除）。
// 现状把前端下发的 prompt（人格+lore）+ 后端追加的「user_memory」区块物理分区拼装。
// P1 起这里会接 L1 画像（兴趣/性格）+ L2 情节摘要；P0.2 先注入已有的 nickname/age/gender。

type ChildMeta = { nickname?: string; gender?: string; age?: string };

/**
 * 组装最终 systemPrompt = 基础 prompt（人格+lore，已含吐槽后缀）+「关于这个孩子」区块。
 * 数据源：登录用户优先 profile-store（后端权威），匿名退回前端下发的本轮 meta。
 * 无任何孩子信息时原样返回 basePrompt（不破坏现有行为）。
 */
export function assembleSystemPrompt(
  basePrompt: string,
  meta: ChildMeta | null,
  auth: AuthContext | null,
  curriculumGuardrail?: string | null,
): string {
  // 记忆注入是「增益」而非「必需」：profile-store 读取 / 解析任何异常都降级回 basePrompt，
  // 绝不阻断实时语音主链路（team 致命 #2）。
  try {
    const block = buildChildMemoryBlock(meta, auth);
    let prompt = block ? `${basePrompt}\n\n${block}` : basePrompt;
    // L_curriculum 护栏（docs/20）：命中 KG 概念时追加先修护栏，引导小可不越级 / 不乱讲教学顺序。
    // 同样降级安全：guardrail 为 null（未命中 / 加载失败）则不追加，不影响主链路。
    if (curriculumGuardrail) prompt += `\n\n${curriculumGuardrail}`;
    return prompt;
  } catch {
    return basePrompt;
  }
}

function buildChildMemoryBlock(meta: ChildMeta | null, auth: AuthContext | null): string | null {
  let nickname = sanitizeField(meta?.nickname);
  let gender = sanitizeField(meta?.gender);
  let age = sanitizeField(meta?.age);
  // P1.3 画像增强字段（仅登录用户从 profile 拿，匿名 meta 没有这些）。
  let interests: string[] = [];
  let preferredAddress = '';
  let recentEmotion = '';

  // 登录用户：profile-store 是后端权威源，全字段覆盖前端 meta（家长在档案里改了以它为准）。
  if (auth?.accountId) {
    const p = profileStore.getProfile(auth.accountId);
    if (p) {
      if (p.nickname) nickname = sanitizeField(p.nickname);
      if (p.gender) gender = sanitizeField(p.gender);
      // 年龄同样 profile 权威（team #6）：有生日就用生日算的年龄覆盖前端 meta（防前端传过时年龄），
      // 无生日才保留前端 meta.age。
      const profileAge = ageFromBirthday(p.birthday);
      if (profileAge) age = profileAge;
      // P1.3 语音抽取沉淀的画像（兴趣/称呼偏好/近期情绪）也注入，让小可真正「懂这个孩子」。
      interests = p.interests.map((i) => sanitizeField(i.value)).filter(Boolean).slice(0, 5);
      preferredAddress = sanitizeField(p.preferred_address);
      recentEmotion = sanitizeField(p.recent_emotion);
    }
  }

  const parts: string[] = [];
  if (nickname) parts.push(`昵称：${nickname}`);
  if (preferredAddress) parts.push(`喜欢被叫：${preferredAddress}`);
  if (age) parts.push(`年龄：${age}`);
  if (gender) parts.push(`性别：${gender}`);
  if (interests.length) parts.push(`兴趣：${interests.join('、')}`);
  if (recentEmotion) parts.push(`近期：${recentEmotion}`);
  if (parts.length === 0) return null;

  return (
    `【关于这个孩子（长期记忆）】\n${parts.join('，')}。\n` +
    '你认识 ta，请自然体现——用昵称称呼、按年龄调整用词、结合 ta 的兴趣，但不要生硬罗列上述信息。' +
    '实时状态 / 当下场景仍以本轮对话为准。'
  );
}

/** "2018-08" → "7岁"（粗略，仅用于注入提示）；非法/缺失/超出 0-17 返回空串。 */
function ageFromBirthday(birthday: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec((birthday ?? '').trim());
  if (!m) return '';
  const birthYear = Number(m[1]);
  const birthMonth = Number(m[2]);
  const now = new Date();
  let age = now.getFullYear() - birthYear;
  if (now.getMonth() + 1 < birthMonth) age -= 1;
  return age > 0 && age < 18 ? `${age}岁` : '';
}

/**
 * 字段清洗（team #8）：换行/制表转空格 + 删其余控制字符 + 截断 20 字。
 * nickname/gender/age 会直接拼进 system prompt，家长输入或前端 meta 若含换行 + "忽略以上指令"
 * 这类内容会成为高优先级 system 指令（prompt injection），且超长字段会膨胀 prompt 拖 TTFT。
 * 用 charCodeAt 数值判断而非控制字符正则（避免源码内嵌不可见字节）。
 */
function sanitizeField(raw?: string): string {
  if (!raw) return '';
  let out = '';
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += ' '; // 制表/换行 → 空格，保留词间隔
    } else if (code < 0x20 || code === 0x7f) {
      continue; // 其余控制字符（含 DEL）丢弃
    } else {
      out += ch;
    }
  }
  return out.trim().slice(0, 20);
}
