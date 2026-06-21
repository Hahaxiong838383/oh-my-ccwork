import { profileStore, type FamilyMember } from './profile-store.js';
import type { AuthContext } from './auth-jwt.js';

// P0.2 后端 Prompt Orchestrator：记忆只在后端汇入 systemPrompt（端无关、可即时剔除）。
// 现状把前端下发的 prompt（人格+lore）+ 后端追加的「user_memory」区块物理分区拼装。
// P1 起这里会接 L1 画像（兴趣/性格）+ L2 情节摘要；P0.2 先注入已有的 nickname/age/gender。

type ChildMeta = { nickname?: string; gender?: string; age?: string };

/**
 * 组装最终 systemPrompt = 基础 prompt（人格+前端世界观，已含吐槽后缀）+「关于这个孩子」区块 + 各按需召回片段。
 * 数据源：登录用户优先 profile-store（后端权威），匿名退回前端下发的本轮 meta。
 * 世界观知识【不常驻】：经济/身世/藏品等由 knowledgeRecall 按需召回注入（xiaoke-kb，命中才给）；无任何注入时原样返回 basePrompt。
 */
export function assembleSystemPrompt(
  basePrompt: string,
  meta: ChildMeta | null,
  auth: AuthContext | null,
  curriculumGuardrail?: string | null,
  aiLiteracyGuide?: string | null,
  onboardingGuide?: string | null,
  knowledgeRecall?: string | null,
): string {
  // 记忆注入是「增益」而非「必需」：profile-store 读取 / 解析任何异常都降级回 basePrompt，
  // 绝不阻断实时语音主链路（team 致命 #2）。
  try {
    const block = buildChildMemoryBlock(meta, auth);
    let prompt = block ? `${basePrompt}\n\n${block}` : basePrompt;
    // 世界观知识【按需召回】注入（xiaoke-kb，仿 K12 curriculum-kg）：孩子聊到经济/身世/藏品/生态缸等才注入对应条目，
    // 闲聊/学习零注入（不常驻、不稀释人格、不拖 TTFT）。召回计算在 pipeline（需孩子本轮文本），这里只负责拼装。
    if (knowledgeRecall) prompt += `\n\n${knowledgeRecall}`;
    // L_curriculum 护栏（docs/20）：命中 KG 概念时追加先修护栏，引导小可不越级 / 不乱讲教学顺序。
    // 同样降级安全：guardrail 为 null（未命中 / 加载失败）则不追加，不影响主链路。
    // AI 启蒙门控（docs/22 §9 双层「门控层」）：双命中让位——学科护栏优先(求解正确性)，AI 启蒙引导仅在
    // 无学科护栏时注入(避免双段 >1600 字稀释人格 / 拖 TTFT)；AI 安全红线已由 basePrompt 的 AI_SAFETY_BASELINE 常驻兜底，双命中不裸奔。
    if (curriculumGuardrail) prompt += `\n\n${curriculumGuardrail}`;
    else if (aiLiteracyGuide) prompt += `\n\n${aiLiteracyGuide}`;
    // 尾部人设锚点（docs/24，team 三发共识破 recency bias）：课程/启蒙护栏追加在末尾时，
    // 长上下文 LLM 的近因效应会让护栏(末尾)盖过世界观(开头)，孩子人设被「老师化」。
    // 末尾再钉一句高张力人设复述(~80字)夺回 recency，比重复整段世界观省 token。
    // 仅在确有护栏注入时加(无护栏不稀释)，且 basePrompt 已含世界观时才有意义。
    if (curriculumGuardrail || aiLiteracyGuide) {
      prompt +=
        '\n\n【牢记】无论上面有什么学习/知识引导，你始终是方舟上的小可——孩子的方舟队友，' +
        '童话陪伴的口吻、温暖好奇的伙伴，绝不变成讲课说教的老师。回答要保持方舟飞船、能量核心、星域探索、生态缸的陪伴感；' +
        '知识只在自然陪伴里轻轻带一句，不考试、不长篇大论、不端着教。';
    }
    // docs/36 onboarding 引导放在【最末尾】——onboarding 期要盖过世界观开头的「欢迎指挥官探险」默认开场，
    // 靠近因效应（docs/24）让 LLM 优先执行「先认识孩子」这一当前任务。
    if (onboardingGuide) prompt += `\n\n${onboardingGuide}`;
    return prompt;
  } catch {
    return basePrompt;
  }
}

export function buildOnboardingGuide(p: FamilyMember | null): string | null {
  // 字段防御：?? '' 兜底非字符串历史/异常数据，避免 .trim() 抛错阻断主链路（failsafe）。
  const missingNickname = !p || !(p.nickname ?? '').trim();
  const missingGender = !p || !(p.gender ?? '').trim();
  const missingBirthday = !p || !(p.birthday ?? '').trim();
  if (!missingNickname && !missingGender && !missingBirthday) return null;

  const lines = [
    '【本轮最高优先·先认识孩子】你和这个孩子还不熟。这一轮回复最重要的事【不是】喊「指挥官」、也【不是】急着邀请去星域探险，而是先温柔地认识 ta。请在这次回复里就自然地引导孩子告诉你下面还缺的信息——一次只问一样，孩子答了就开心地接住、夸一夸 ta，问到了就记住、别再重复问，绝不要像查户口/填表一样连珠炮发问：',
  ];
  if (missingNickname) lines.push('· 你还不知道孩子叫什么——温柔地问 ta 的名字，或者喜欢你怎么称呼 ta。');
  if (missingGender) lines.push('· 你还不知道孩子是男孩还是女孩——找个自然的机会轻轻问一句（比如「你是小哥哥还是小妹妹呀」）。');
  if (missingBirthday) lines.push('· 你还不知道孩子的出生年月——可以问问 ta 的生日是什么时候、是哪一年生的；如果孩子说不清楚，就温柔地说「没关系呀，让爸爸妈妈在小可的 App 里悄悄告诉我就好啦」，不要追问、不要为难 ta。');
  lines.push('这些信息你都会记住。等认识齐了，再像方舟队友一样陪 ta 探险玩耍；在认识齐之前，每轮回复都要把「问下一个还缺的信息」放进去，别光顾着聊探险忘了认识 ta。');
  return lines.join('\n');
}

function buildChildMemoryBlock(meta: ChildMeta | null, auth: AuthContext | null): string | null {
  let nickname = sanitizeField(meta?.nickname);
  let gender = sanitizeField(meta?.gender);
  let age = sanitizeField(meta?.age);
  // P1.3 画像增强字段（仅登录用户从 profile 拿，匿名 meta 没有这些）。
  let interests: string[] = [];
  let preferredAddress = '';
  let recentEmotion = '';
  let gameProgress: string[] = [];

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
      // docs/25 问题4：方舟冒险事件记忆（game_progress），注入最近 3 条让小可记得共同经历。
      // 末位最新（profile-store 按时间升序存），取最近 3 条。
      gameProgress = p.game_progress.map((g) => sanitizeField(g.value)).filter(Boolean).slice(-3);
    }
  }

  const parts: string[] = [];
  if (nickname) parts.push(`昵称：${nickname}`);
  if (preferredAddress) parts.push(`喜欢被叫：${preferredAddress}`);
  if (age) parts.push(`年龄：${age}`);
  if (gender) parts.push(`性别：${gender}`);
  if (interests.length) parts.push(`兴趣：${interests.join('、')}`);
  if (recentEmotion) parts.push(`近期：${recentEmotion}`);
  if (gameProgress.length) parts.push(`方舟经历：${gameProgress.join('、')}`);
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
