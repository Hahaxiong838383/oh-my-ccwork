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
): string {
  const block = buildChildMemoryBlock(meta, auth);
  return block ? `${basePrompt}\n\n${block}` : basePrompt;
}

function buildChildMemoryBlock(meta: ChildMeta | null, auth: AuthContext | null): string | null {
  let nickname = (meta?.nickname ?? '').trim();
  let gender = (meta?.gender ?? '').trim();
  let age = (meta?.age ?? '').trim();

  // 登录用户：profile-store 是后端权威源，覆盖前端 meta（家长在档案里改了名字以它为准）。
  if (auth?.accountId) {
    const p = profileStore.getProfile(auth.accountId);
    if (p) {
      if (p.nickname) nickname = p.nickname;
      if (p.gender) gender = p.gender;
      if (!age) age = ageFromBirthday(p.birthday);
    }
  }

  const parts: string[] = [];
  if (nickname) parts.push(`昵称：${nickname}`);
  if (age) parts.push(`年龄：${age}`);
  if (gender) parts.push(`性别：${gender}`);
  if (parts.length === 0) return null;

  return (
    `【关于这个孩子（长期记忆）】\n${parts.join('，')}。\n` +
    '你认识 ta，请自然体现——用昵称称呼、按年龄调整用词与内容深度，但不要生硬罗列上述信息。' +
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
