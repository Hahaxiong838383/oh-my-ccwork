import type { LoreEntity } from './types';

/**
 * 实体表 · 统一 canonical ID 防同物异名（team 评审建议③）
 *
 * 散文里同一实体可能有多种叫法（"夜航/出航/星域探索"），都映射到同一 id。
 * 现阶段用于 prompt 里精确引用提示；将来上 KG 时这就是现成的实体对齐表（杜绝事后清洗）。
 */
export const LORE_ENTITIES: LoreEntity[] = [
  { id: 'ark', name: '方舟', aliases: ['时空方舟', '飞船', '超级飞船'], type: 'place' },
  { id: 'xiaoke', name: '小可', aliases: ['K1', 'K1 机器人', '数字伙伴'], type: 'role' },
  { id: 'commander', name: '指挥官', aliases: ['孩子', '舰长'], type: 'role' },
  { id: 'guangling', name: '光灵', aliases: ['光之精灵', '晶体生物'], type: 'role' },
  { id: 'entropy_beast', name: '熵兽', aliases: [], type: 'role' },
  { id: 'ecosystem', name: '生态缸', aliases: ['家园', '小可的家', '地球模拟区'], type: 'place' },
  { id: 'ark_building', name: '方舟建筑', aliases: ['引擎', '孵化室', '穹顶', '护盾', '研磨机', '雷达'], type: 'building' },
  { id: 'night_voyage', name: '夜航', aliases: ['夜间航行', '离线收集', '出航'], type: 'mechanic' },
  { id: 'supply_pile', name: '物资堆', aliases: ['离线奖励', '夜航收获'], type: 'item' },
  { id: 'box', name: '宝箱', aliases: ['时空宝箱', '结晶'], type: 'item' },
  { id: 'stardust', name: '星尘', aliases: ['尘埃'], type: 'currency' },
  { id: 'family_coin', name: '家族币', aliases: [], type: 'currency' },
  { id: 'newbie_halo', name: '三色光环', aliases: ['新手福利', '新舰长祝福', '光环'], type: 'mechanic' },
  { id: 'collectible', name: '藏品', aliases: ['探险家宝库', '星梦奇境'], type: 'collectible' },
  { id: 'growth_guide', name: '新手引导', aliases: ['人生第一次', '成长线'], type: 'lore' },
  { id: 'device', name: '读写台硬件', aliases: ['台灯', '设备', '桌子'], type: 'item' },
  // —— v1.0 创世故事实体（叙事层；可聊正文归 server xiaoke-kb 按需召回，此处仅 canonical 对齐 + 为 KG 铺路）——
  { id: 'micro_light', name: '微光', aliases: ['认真生活之光', '认真的光', '心里的光'], type: 'lore' },
  { id: 'lampkeeper', name: '守灯人', aliases: [], type: 'role' },
  { id: 'old_engineer', name: '守灯工程师', aliases: ['老爷爷', '博士'], type: 'role' },
  { id: 'snore_king', name: '打呼噜大王', aliases: ['呼噜大王'], type: 'role' },
  { id: 'sleepy_bug', name: '瞌睡虫', aliases: ['瞌睡虫们'], type: 'role' },
  { id: 'abyss', name: '长眠之渊', aliases: [], type: 'place' },
  { id: 'cradle_zone', name: '摇篮星域', aliases: ['家门口'], type: 'place' },
  { id: 'starsea', name: '星海', aliases: ['睡雾', '迷雾'], type: 'place' },
  { id: 'life_seed', name: '生命之种', aliases: ['种子', '蛋'], type: 'item' },
  { id: 'light_core', name: '光核', aliases: ['方舟的心脏', '头顶的灯'], type: 'building' },
  { id: 'cockpit', name: '驾驶舱', aliases: ['书桌', '小书桌'], type: 'place' },
  { id: 'porthole', name: '舷窗', aliases: ['读写台玻璃'], type: 'item' },
  { id: 'glass_tank', name: '玻璃缸', aliases: ['最早的缸', '生命起点'], type: 'item' },
];

export function getEntity(id: string): LoreEntity | undefined {
  return LORE_ENTITIES.find((e) => e.id === id);
}
