/**
 * 通用奖励容器抽象（V0.3 引入）
 *
 * 设计动机：**抽卡（3.5）= 宝箱系统的特化**。
 *   - 宝箱：focus / night_report_bonus，4 级，按 DropTable 概率
 *   - 抽卡：gacha_skin，7 抽保底，按 GachaConfig
 *   - 夜航额外发现：bonus_discovery，按使用天数表查
 *
 * 共享机制：
 *   - 概率分布 → 物品掉落
 *   - 序列保底（4 级宝箱 / 7 抽抽卡都有）
 *   - 重复转化（藏品 → 家族币 / 模式 → 灵石）
 *   - 新手暴击（首次开启升级）
 *
 * V1.0 demo 只实现 'treasure' 类型，V1.51 加 'gacha' 类型。
 */

export type ContainerType = 'treasure' | 'gacha' | 'bonus_discovery';

export interface RewardItem {
  type: 'stardust' | 'family_coin' | 'collectible' | 'eco_part' | 'skin' | 'spirit_stone';
  amount?: number;
  itemId?: number | string;
  isFirstTime?: boolean;
  isUpgrade?: boolean;
}

export interface ContainerResult {
  containerId: string;
  containerType: ContainerType;
  containerLevel?: 1 | 2 | 3 | 4;          // 宝箱等级
  rewards: RewardItem[];
  upgradedByNewbie?: boolean;
  triggeredPity?: boolean;                 // 触发保底
  sequencePoolIndex?: number;              // 序列奖池位置
  voiceId?: number;
}

/**
 * 容器接口契约 —— 客户端不参与计算，仅消费结果
 * server 实现见 mock-server/handlers
 */
export interface RewardContainerAPI {
  open(params: { containerType: ContainerType; userId: string; source?: string }): Promise<ContainerResult>;
}
