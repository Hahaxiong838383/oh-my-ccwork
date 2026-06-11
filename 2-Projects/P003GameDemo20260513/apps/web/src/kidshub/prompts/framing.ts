/**
 * Framing Layer · 话语角度池（team 第一性原理 grok 提出，cc 整合）
 *
 * 根因不是"事实太少"，而是小可被定义成"没有表达自由度的事实奴隶"——
 * 同一条事实只有一种说法。framing 把「说什么事实」与「用什么角度说」解耦：
 * 角度是封闭集合、与事实无关、可正交采样。每次进卡随机选一个不同的角度注入，
 * 即使真实状态只有一条事实，也能像"这次刚好想到它的这一面"。
 *
 * 真实上线兜底：角度只改变信息在孩子脑中的激活路径，不声称任何新事实，
 * 所以「真实只有一条变化」的日子也完全合法，不破真实性铁律。
 */
export interface FramingAngle {
  id: string;
  label: string;
  /** 注入给 LLM 的角度提示（拼进本轮触发指令） */
  hint: string;
}

export const FRAMING_ANGLES: FramingAngle[] = [
  { id: 'phenomenon', label: '现象邀请', hint: '先描述这件事此刻的样子，再轻轻邀请孩子一起看' },
  { id: 'attribution', label: '归因充能', hint: '把这件事和孩子白天的专注、给方舟充能联系起来' },
  { id: 'ecology', label: '生态意义', hint: '点出这件事对生态缸这个家、对方舟的小小意义' },
  { id: 'foreshadow', label: '前瞻钩子', hint: '把这件事说成更好变化的预兆，留一个小期待' },
  { id: 'emotion', label: '情感共振', hint: '表达你和孩子一起守护、一起惊喜的心情' },
  { id: 'detail', label: '细节放大', hint: '只聚焦其中一个具体的小细节，把那一点放大来说' },
];

/** 随机选一个角度，避开上次用过的，避免连续同角度 */
export function pickFreshAngle(lastId: string | null): FramingAngle {
  const pool = FRAMING_ANGLES.filter((a) => a.id !== lastId);
  const list = pool.length > 0 ? pool : FRAMING_ANGLES;
  const idx = Math.floor(Math.random() * list.length);
  return list[idx];
}
