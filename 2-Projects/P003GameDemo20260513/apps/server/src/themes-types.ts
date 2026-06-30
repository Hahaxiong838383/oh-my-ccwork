/**
 * 主题词表 · 类型契约（前后端共享单一真相源）
 *
 * 架构（决策见 ADR-06）：
 * - feedback.theme 字段仍是字符串（不破现有 schema/数据）
 * - themes 表存「主题元数据」：id（= 当前字符串值，等于 display_name）+ color + sort + active + system
 * - admin 改 display_name 时事务里 UPDATE feedback.theme = 新值（联动 rename），id 同步变
 * - 软删 active=0：feedback 引用仍渲染（chip 灰 + (已禁用)），admin 可重新启用或改归类
 * - system=1：「未分类」「其他」锁定，不可删/不可改 id，可改 color/sort/display_name 但 id 与 display_name 保持同步
 *
 * 出厂 seed（首次启动）：硬编码 13 项预设作为种子数据写入 themes 表，「未分类」「其他」标 system=1。
 */

export interface FeedbackTheme {
  /** id = display_name（C 方案：中文 id + display_name 同步）。改名时事务联动 feedback.theme rename */
  id: string;
  /** 显示名（等于 id，C 方案不分离） */
  display_name: string;
  /** chip 颜色 hex（#0EA5C0 等） */
  color: string;
  /** 排序号（看板/抽屉下拉顺序） */
  sort_order: number;
  /** 是否启用（1=正常，0=软删） */
  active: number;
  /** 系统级（1=「未分类」「其他」锁定不可删，0=普通可删） */
  system: number;
  created_at: number;
  updated_at: number;
}

/** POST /api/feedback-themes 创建 */
export interface ThemeCreateInput {
  /** 唯一 + 非空，不可与现有 active+inactive 冲突 */
  id: string;
  color: string;
  sort_order?: number;
}

/** PATCH /api/feedback-themes/:id */
export interface ThemePatchInput {
  /** 新 display_name = 新 id，事务联动 UPDATE feedback；system=1 时允许改 */
  new_id?: string;
  color?: string;
  sort_order?: number;
  /** 0=软删，1=启用；system=1 拒改为 0 */
  active?: number;
}

/**
 * 出厂 seed 13 项预设（首次启动写入；已存在则跳过）。
 * 注：「未分类」「其他」标 system=1。
 */
export const SEED_THEMES: ReadonlyArray<Omit<FeedbackTheme, 'created_at' | 'updated_at'>> = [
  { id: '未分类', display_name: '未分类', color: '#9aa4ae', sort_order: 0, active: 1, system: 1 },
  { id: '功能类', display_name: '功能类', color: '#0EA5C0', sort_order: 10, active: 1, system: 0 },
  { id: '体验类', display_name: '体验类', color: '#E91E72', sort_order: 20, active: 1, system: 0 },
  { id: '夜航·内容', display_name: '夜航·内容', color: '#5B7CCC', sort_order: 30, active: 1, system: 0 },
  { id: '专注·交互', display_name: '专注·交互', color: '#3B7A99', sort_order: 40, active: 1, system: 0 },
  { id: '皮肤·养成', display_name: '皮肤·养成', color: '#E8833A', sort_order: 50, active: 1, system: 0 },
  { id: '周报·可读性', display_name: '周报·可读性', color: '#7E4FBF', sort_order: 60, active: 1, system: 0 },
  { id: '登舰·体验', display_name: '登舰·体验', color: '#4A9DF0', sort_order: 70, active: 1, system: 0 },
  { id: '生态·养成', display_name: '生态·养成', color: '#3DBE78', sort_order: 80, active: 1, system: 0 },
  { id: '记忆·联动', display_name: '记忆·联动', color: '#9B7BF0', sort_order: 90, active: 1, system: 0 },
  { id: 'KidsHub·建议', display_name: 'KidsHub·建议', color: '#F6A724', sort_order: 100, active: 1, system: 0 },
  { id: '设备·设置', display_name: '设备·设置', color: '#6B7785', sort_order: 110, active: 1, system: 0 },
  { id: '其他', display_name: '其他', color: '#909399', sort_order: 999, active: 1, system: 1 },
];
