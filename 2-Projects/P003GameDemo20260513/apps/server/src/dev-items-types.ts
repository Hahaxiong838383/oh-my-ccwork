/**
 * 产品开发看板 · 类型契约（前后端共享单一真相源）
 *
 * 业务流程：
 *   admin 在 Issue 看板把孩子反馈打「已采纳」→ 升级为开发条目 DevItem
 *   开发条目走「规划中 → 开发中 → 已上线」三态流转
 *   多条 feedback 可关联到同一 DevItem（多对多）
 *   流转到「已上线」时 admin 可触发「致谢名单已下发」标记（不实际推送，只打标）
 *
 * 自动聚合规则（updateAggregation()）：
 *   - source_themes 默认 = 关联 feedback 的 theme uniq 集合（admin 加/删 chip 后锁住）
 *   - representative_quote 默认 = 关联 feedback 中 text 最长那条
 *     admin 改过后锁住（quote_locked=1），关联 feedback 增减时不再覆盖
 */

/** 改动分级：决定上线节奏 + 是否走公开预告 */
export const DEV_ITEM_LEVELS = ['大功能', '小改'] as const;
export type DevItemLevel = (typeof DEV_ITEM_LEVELS)[number];

/** 状态三态：admin 点 chip 流转 */
export const DEV_ITEM_STATUSES = ['规划中', '开发中', '已上线'] as const;
export type DevItemStatus = (typeof DEV_ITEM_STATUSES)[number];

/** 完整 DevItem（含关联 feedback 概要，用于看板渲染） */
export interface DevItem {
  id: string;
  title: string;
  description: string;
  level: DevItemLevel;
  status: DevItemStatus;
  /** 代表性引用（admin 可改；锁定后自动聚合不覆盖） */
  representative_quote: string;
  /** quote 是否被 admin 改过（1=锁，不被自动聚合覆盖；0=未改，关联变了自动重算） */
  quote_locked: number;
  /** 来源主题 JSON 数组（同 quote 一样可被 admin 改 + 锁） */
  source_themes: string[];
  /** themes 是否被 admin 改过 */
  themes_locked: number;
  created_at: number;
  updated_at: number;
  /** 流转到「已上线」时记一次（NULL = 未上线） */
  launched_at: number | null;
  /** 致谢名单已下发时间戳（NULL = 未发；不防重发，admin 可重新点） */
  thanks_sent_at: number | null;
  updated_by: string;
  /** 关联的 feedback id 列表（GET 接口拼出来；store 内部读关联表） */
  feedback_ids: string[];
  /** 关联的 feedback 数量（看板卡片显示「源自 N 条工单」） */
  feedback_count: number;
}

/** POST /api/dev-items 创建入参 */
export interface DevItemCreateInput {
  title: string;
  description?: string;
  level: DevItemLevel;
  /** 可选：初始关联的 feedback id 列表（promote 入口从 Issue 抽屉传入） */
  feedback_ids?: string[];
}

/** PATCH /api/dev-items/:id 改字段 */
export interface DevItemPatchInput {
  title?: string;
  description?: string;
  level?: DevItemLevel;
  status?: DevItemStatus;
  /** admin 手改 quote → 自动 lock；传 null 解锁回自动聚合 */
  representative_quote?: string | null;
  /** admin 手改 themes → 自动 lock；传 null 解锁回自动聚合 */
  source_themes?: string[] | null;
}

/**
 * 反向查：feedback id → 所属 dev_item summary（Issue 抽屉「已进入开发看板」标识用）
 * 一个 feedback 可关联多个 DevItem（建议 UI 只展示第一个，admin 自己控制）
 */
export interface FeedbackDevItemLink {
  feedback_id: string;
  dev_item_id: string;
  dev_item_title: string;
  dev_item_status: DevItemStatus;
}
