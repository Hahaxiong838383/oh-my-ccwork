import type { PromptVariable } from './types';

/**
 * 运行时占位符 · 《小可 AI 产品定义》V2.0 · B.2 约定表
 *
 * defaultValue 为 demo mock 值，刻意与八张场景卡的示例话术对账一致
 * （30 颗星尘 / 小鱼新花纹 / 喜欢恐龙 / 45 分钟），让默认体验开箱对得上账。
 * {scene_prompt} 不在此表——由场景卡选择注入，见 compose.ts。
 */
export const PROMPT_VARIABLES: PromptVariable[] = [
  {
    key: 'nickname',
    label: '孩子昵称',
    source: '家长预设 > AI 随机词库兜底',
    defaultValue: '朵朵',
  },
  {
    key: 'gender',
    label: '孩子性别',
    source: '登录页家长/孩子选择（男 / 女）',
    defaultValue: '男',
  },
  {
    key: 'age',
    label: '孩子年龄',
    source: '登录页家长/孩子填写（岁）',
    defaultValue: '8',
  },
  {
    key: 'commander_suffix',
    label: '指挥官后缀开关',
    source: '场景判定：登舰 / 授勋 / 回归高光 / 夜航结算 = on',
    defaultValue: 'off',
  },
  {
    key: 'device_state',
    label: '设备 / 玩法已锁定状态',
    source: '状态接口，只注入已锁定值',
    // 护栏（team 边界审查 claude）：
    // - 数值类（夜航收益的小时/星尘）= 单组，整段对话唯一，绝不进多条池（防数字漂移对不上账）
    // - 描述类（生态缸变化）= 多条真实已发生变化，让小可每次挑不同的说（解决「每次讲小鱼」）
    // - 明日预告 = 多条且每条带「已锁定」，card6 关机预告只能从这里挑（预告必兑现红线）
    defaultValue: JSON.stringify(
      {
        灯光: { 开: true, 亮度: '80%' },
        色温: '暖光 4000K',
        音量: '50%',
        像距: '舒适档',
        夜航收益: { 离线小时: 10, 星尘: 30 },
        生态缸变化: [
          '小鱼身上长出了淡紫色的新花纹',
          '发光水草开了三朵蓝色的小花',
          '缸底多了一块像红宝石的小矿石',
          '一只发光的小海螺爬上了珊瑚',
        ],
        明日预告: [
          '明天小鱼会学会吐泡泡圈（已锁定）',
          '明天生态缸要点亮一座珊瑚灯塔（已锁定）',
          '明天会孵化出一只会发光的小海马（已锁定）',
        ],
      },
      null,
      2,
    ),
    multiline: true,
  },
  {
    key: 'confirmed_memories',
    label: '已确认记忆列表',
    source: '记忆库确认态（候选记忆不注入）',
    defaultValue: JSON.stringify(
      ['喜欢恐龙', '上次说想养一只会发光的电子小狗', '说过长大想去火星种土豆'],
      null,
      2,
    ),
    multiline: true,
  },
  {
    key: 'focus_today',
    label: '今日累计专注分钟',
    source: '本地数据库',
    defaultValue: '45',
  },
  {
    key: 'focus_yesterday',
    label: '昨日累计专注分钟',
    source: '本地数据库',
    defaultValue: '120',
  },
];

export function defaultVariableValues(): Record<string, string> {
  return Object.fromEntries(PROMPT_VARIABLES.map((v) => [v.key, v.defaultValue]));
}
