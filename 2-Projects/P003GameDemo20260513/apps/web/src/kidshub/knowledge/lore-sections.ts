import type { LoreSection } from './types';

/**
 * L2 场景素材库 · 按当前卡的相关性路由注入 1-2 节（反重复弹药库）
 *
 * 精炼自《小可世界观知识手册 v0.3》。每节 body 是小可视角的可聊素材，已剔工程细节。
 * sceneTags/entities 是为将来 KG/检索铺路的 front-matter（team 评审建议①）。
 * 守真实性边界：foreshadow 节是 D30+/后续伏笔，默认不注入（CARD_LORE_MAP 不挂任何卡）。
 */
export const LORE_SECTIONS: LoreSection[] = [
  {
    id: 'night_voyage',
    title: '夜航与开关机',
    sceneTags: ['夜航', '回归', '关机'],
    entities: ['ark', 'night_voyage', 'supply_pile'],
    body: '夜航：合盖后方舟自动出航离线收集，带回物资堆（Low/Mid/High 三等级，离开越久越丰富）。开机时小可汇报"夜航报告"。关机告别后方舟去夜航，明天带宝箱回来。专注分两种：探索（小可出航飞出去）/ 陪伴（小可在身边陪读）。',
  },
  {
    id: 'collectibles',
    title: '藏品（分性别）',
    sceneTags: ['夜航', '宝箱', '回归'],
    entities: ['collectible', 'box'],
    body: '藏品（夜航带回，分性别）：男孩「探险家宝库」——机械恐龙、武器遗迹（远古符文）、能量晶石（内部漩涡）、宇宙巨兽标本；女孩「星梦奇境」——幻光花植、童话信物（戒指/挂坠）、梦幻水晶、星际歌姬。这些是世界里"存在"的藏品品类，小可讲品类（如"史诗级机械恐龙组件"）而非笼统的"一个宝箱"。〔但"这次具体带回哪一件"以 device_state 为准，device_state 里没有的别编成孩子已拥有。〕',
  },
  {
    id: 'ecosystem',
    title: '生态缸与方舟建筑',
    sceneTags: ['回归', '关机', '日常'],
    entities: ['ecosystem', 'ark_building'],
    body: '生态缸（小可的家）：在这个世界里，生态缸会随孩子专注从荒芜慢慢变繁荣——可能长出星光草（Lv1 幼苗→Lv3 茂盛越长越亮）、能量矿等，建筑有废墟→Lv1→满级三态。方舟有六大建筑（引擎/孵化室/穹顶/护盾/研磨机/雷达），升级=修复方舟模块、解锁新场景。〔但"此刻缸里长到哪一步、有没有星光灿烂"以 device_state 为准——别把世界设定里的繁荣景象当成孩子的当前进度。〕',
  },
  {
    id: 'rewards',
    title: '奖励与经济',
    sceneTags: ['夜航', '宝箱', '日常'],
    entities: ['stardust', 'family_coin', 'box'],
    body: '两种货币：星尘（给小可买皮肤换装，来自夜航报告）、家族币（生态缸建设/开箱）。宝箱 4 级：普通→精品→史诗→传说，等级越高开箱动画越炸。',
  },
  {
    id: 'newbie_halo',
    title: '新手福利·三色光环',
    sceneTags: ['新手', '夜航'],
    entities: ['newbie_halo'],
    body: '新手福利「三色光环」（限时，随天数变色最后消失，作用=提升收益+提高幸运概率）：金色=当天首个宝箱必暴击+离线星尘翻倍；紫色=首个宝箱升史诗级；蓝色=首个低级宝箱升一级（新手期尾声）。颜色+剩余天数系统实时给，每天必不同。具体天数/倍率数值未公开——只讲机制，"还剩 X 天"走系统实时取值，不编数字。',
  },
  {
    id: 'growth_line',
    title: '新手成长线（回忆锚点）',
    sceneTags: ['记忆', '登舰', '日常'],
    entities: ['growth_guide'],
    body: '新手 6 段引导（每段只在第一次遇到那功能时出现）：设置/登舰/夜航报告/专注/生态缸/切换。登舰认证=指纹按压或说"登舰"。金光时刻（值得郑重庆祝）：登舰成功、首次开箱、首次获得生态缸部件。这 6 个"人生第一次"是孩子真实经历过、有先后的事件，小可能做回忆杀（"还记得你第一次登舰吗"）。',
  },
  {
    id: 'xiaoke_life',
    title: '小可的个人生活',
    sceneTags: ['日常', '陪伴', '记忆'],
    entities: ['xiaoke'],
    body: '小可个人生活（无穷且 100% 真实的可聊素材）：换装（孩子用星尘买皮肤、随时切换给小可打扮）、多套待机动作（挥手/转圈/点头，随机不连续重复，像有自己的小生活）、唤醒词（小可小可/你好小可/爱视可）、陪伴模式在身边陪读、可被孩子随时打断。',
  },
  {
    id: 'settings_hw',
    title: '设置与硬件（帮调台子）',
    sceneTags: ['查询', '帮忙', '坐姿'],
    entities: ['device'],
    body: '小可能帮孩子调真实读写台硬件：灯光亮度（低/中/高）、色温（常规/绘画/夜读）、音量（0~100%，静音时喊"小可小可"自动升 30%）、桌子高度。"绘画""夜读"档名贴生活场景，适合小可推荐（"要写字了，给你切到绘画档好不好"）。调设置时专注计时/开箱/夜航照常跑。',
  },
  {
    id: 'foreshadow',
    title: '世界观伏笔（不主动讲·备查）',
    sceneTags: [],
    entities: ['guangling', 'entropy_beast'],
    body: '〔伏笔，小可现阶段不主动讲〕光灵：专注能量凝聚的晶体生物（5 基底×6 水晶=30 形态，幼体宠物/成体坐骑），V2.0 上线，前期由小可代替出航探索。熵兽：由"惰性"凝聚的 Boss，V3.0 需集结好友组「联合舰队」击败（"对抗惰性=坚持专注"的隐喻）。版本：V1.0 基础 / V1.5 家长端 / V2.0 光灵养成 / V3.0 社交剧情。',
  },
];

/**
 * 卡 → 相关素材节映射（L2 静态路由表）。
 * getKnowledge(cardId) 据此选节，每卡 pick 1-2 节并跨轮避重（grok 注入引擎实现）。
 * 注意：foreshadow 不挂任何卡（默认不注入，守"不主动讲后续功能"红线）。
 */
export const CARD_LORE_MAP: Record<string, string[]> = {
  card1: ['growth_line', 'xiaoke_life'], // 登舰破冰：成长线回忆 + 小可生活
  card2: ['night_voyage', 'collectibles', 'rewards'], // 夜航呼唤：夜航+藏品+收益
  card3: ['ecosystem', 'night_voyage', 'collectibles'], // 回归承接：生态缸变化+夜航累积
  card4: ['growth_line', 'xiaoke_life'], // 记忆复现：人生第一次 + 小可生活
  card5: ['xiaoke_life'], // KidsHub 情绪回应：小可生活
  card6: ['ecosystem', 'night_voyage'], // 关机预告：明日生态缸/夜航变化
  card7: ['xiaoke_life', 'settings_hw'], // 坐姿吐槽：小可生活 + 设置
  card8: ['settings_hw'], // 设备查询：设置硬件
};

export function getSection(id: string): LoreSection | undefined {
  return LORE_SECTIONS.find((s) => s.id === id);
}
