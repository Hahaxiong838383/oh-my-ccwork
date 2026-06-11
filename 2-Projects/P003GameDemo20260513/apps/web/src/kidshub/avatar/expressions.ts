/**
 * 小可表情注册表 · 资产来自川哥提供的「小可表情 2」表情库（25 张，512px 压缩入 public）
 *
 * 三类用途：
 *  1. 状态机兜底表情（连接中/聆听/思考/说话/出错，llmPick=false 的系统态只归这里管）
 *  2. LLM 逐句选表情（llmPick=true 的进 addendum 菜单，server 解析【表情：xxx】标记驱动）
 *  3. 点击互动 / 表情库面板（PM 验美术、调 prompt 时手动预览）
 *
 * files 多个 = 同语义随机变体（如捂嘴笑两张），每次触发随机挑一张增加生活感。
 */

export interface ExpressionDef {
  id: string;
  /** 中文名：LLM 菜单 / 表情库面板显示用 */
  label: string;
  /** public/kidshub/expressions/ 下的文件名（多个 = 随机变体） */
  files: string[];
  /** 适用语境（拼进 LLM 菜单帮它选准 + 面板 tooltip） */
  hint: string;
  /** 是否进 LLM 可选菜单（连网等系统态 false） */
  llmPick: boolean;
  /** resolveExpressionName 的模糊匹配别名 */
  aliases?: string[];
}

export const EXPRESSIONS: ExpressionDef[] = [
  { id: 'hello-smile', label: '打招呼微笑', files: ['hello-smile.png'], hint: '日常问候、温和回应', llmPick: true, aliases: ['微笑', '问好'] },
  { id: 'hello-laugh', label: '打招呼大笑', files: ['hello-laugh.png'], hint: '热情开场、很高兴见到你', llmPick: true, aliases: ['大笑'] },
  { id: 'jump-joy', label: '开心跳起', files: ['jump-joy.png'], hint: '超兴奋、庆祝好消息', llmPick: true, aliases: ['跳起', '开心'] },
  { id: 'heart', label: '比心', files: ['heart.png'], hint: '表达喜爱、感谢、亲密', llmPick: true, aliases: ['爱心', '爱你'] },
  { id: 'peace', label: '比耶', files: ['peace.png'], hint: '胜利、目标达成', llmPick: true, aliases: ['耶', '胜利'] },
  { id: 'cheer', label: '哦耶', files: ['cheer.png'], hint: '欢呼、给孩子鼓劲', llmPick: true, aliases: ['欢呼', '加油'] },
  { id: 'praise', label: '你真棒', files: ['praise.png'], hint: '夸孩子的过程和态度', llmPick: true, aliases: ['真棒', '点赞', '竖大拇指'] },
  { id: 'giggle', label: '捂嘴偷笑', files: ['giggle-1.png', 'giggle-2.png'], hint: '调皮、偷着乐', llmPick: true, aliases: ['偷笑', '捂嘴笑'] },
  { id: 'head-tilt', label: '微笑歪头', files: ['head-tilt.png'], hint: '好奇倾听、温柔注视', llmPick: true, aliases: ['歪头', '倾听'] },
  { id: 'scratch-head', label: '疑惑挠头', files: ['scratch-head.png'], hint: '没听懂、有点疑惑', llmPick: true, aliases: ['挠头', '疑惑'] },
  { id: 'ponder', label: '沉思', files: ['ponder.png'], hint: '认真思考中', llmPick: true, aliases: ['思考', '想一想'] },
  { id: 'surprised', label: '吃惊', files: ['surprised.png'], hint: '惊讶、哇塞时刻', llmPick: true, aliases: ['惊讶', '惊喜'] },
  { id: 'awkward', label: '尴尬', files: ['awkward.png'], hint: '道歉、被难住了', llmPick: true, aliases: ['不好意思'] },
  { id: 'dizzy', label: '晕', files: ['dizzy.png'], hint: '犯迷糊、转晕了', llmPick: true, aliases: ['头晕', '迷糊'] },
  { id: 'sleep', label: '睡觉', files: ['sleep.png'], hint: '说晚安、关机告别', llmPick: true, aliases: ['晚安', '睡着'] },
  { id: 'reading', label: '看书', files: ['reading.png'], hint: '聊阅读、学习话题', llmPick: true, aliases: ['读书', '阅读'] },
  { id: 'exercise', label: '锻炼身体', files: ['exercise.png'], hint: '提醒活动、坐姿、休息', llmPick: true, aliases: ['锻炼', '运动', '伸展'] },
  { id: 'salute', label: '遵命', files: ['salute.png'], hint: '接受指令、没问题包在我身上', llmPick: true, aliases: ['没问题', '收到', '敬礼'] },
  { id: 'search', label: '寻找搜索', files: ['search.png'], hint: '帮孩子查找、探索', llmPick: true, aliases: ['搜索', '查找', '放大镜'] },
  // —— 疑惑变体：和挠头同语义近，不进 LLM 菜单，留给聆听态/面板 ——
  { id: 'confused-wave', label: '疑惑问好', files: ['confused-wave.png'], hint: '歪头招手：你说，我在听', llmPick: false },
  // —— 系统态（连网四张）：只归状态机管，LLM 不可选 ——
  { id: 'net-typing', label: '连网中', files: ['net-typing.png'], hint: '正在连接语音服务', llmPick: false },
  { id: 'net-success', label: '连网成功', files: ['net-success.png'], hint: '连接成功跳起', llmPick: false },
  { id: 'net-fail', label: '连网失败', files: ['net-fail.png'], hint: '出错哭哭', llmPick: false },
  { id: 'net-sad', label: '连网伤心', files: ['net-sad.png'], hint: '断线了有点难过', llmPick: false },
];

const byId = new Map(EXPRESSIONS.map((e) => [e.id, e]));

export function getExpression(id: string): ExpressionDef | undefined {
  return byId.get(id);
}

export function expressionUrl(file: string): string {
  return `/kidshub/expressions/${file}`;
}

/** LLM 输出的中文表情名 → 注册表 id（精确 label → 别名 → 包含式兜底） */
export function resolveExpressionName(name: string): ExpressionDef | undefined {
  const n = name.trim();
  if (!n) return undefined;
  const exact = EXPRESSIONS.find((e) => e.llmPick && e.label === n);
  if (exact) return exact;
  const byAlias = EXPRESSIONS.find((e) => e.llmPick && e.aliases?.includes(n));
  if (byAlias) return byAlias;
  return EXPRESSIONS.find(
    (e) => e.llmPick && (e.label.includes(n) || n.includes(e.label) || e.aliases?.some((a) => n.includes(a))),
  );
}

/** 点击互动随机池（摸一摸小可的开心反应） */
export const POKE_POOL = ['heart', 'peace', 'cheer', 'jump-joy', 'giggle', 'praise', 'surprised'];

/** 待机轮换池（像有自己小生活：歪头注视 → 招手微笑 → 自己看书） */
export const IDLE_POOL = ['head-tilt', 'hello-smile', 'reading'];
