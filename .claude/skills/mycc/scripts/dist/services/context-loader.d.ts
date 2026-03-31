/**
 * 共享记忆上下文加载器 v5.5
 *
 * 为 Codex / Gemini CLI 调用动态注入记忆上下文。
 * 两层：
 * 1. RECENT_EVENTS.md 尾部（最近事件）
 * 2. memory-items.md 混合检索（向量语义 + 关键词 TF-IDF + 时间衰减 + MMR 去重 + 残差版本链）
 *
 * v5.5 升级（借鉴 QMD reranker pipeline）：
 * - LLM 重排：MMR 后用 Qwen3-Reranker-0.6B 对 Top 20 候选二次打分
 * - 最终分数 = 0.6 * rerankScore + 0.4 * originalScore
 * - 降级：Ollama 不可用或 reranker 模型未加载时跳过，直接用 MMR 结果
 *
 * v4.5 保留：
 * - RRF 融合：三路检索结果用 Reciprocal Rank Fusion 统一排序
 * - 检索轨迹：每次注入记录命中类别/条目/分数，写入 trajectories/recall-*.jsonl
 *
 * v4 保留：
 * - 向量语义检索：Qwen3-Embedding-0.6B (512维) + 余弦相似度
 * - 残差版本链：#base + →Δ: 替代旧 →updates:，信息不再丢失
 * - 降级机制：Ollama 不可用时自动 fallback 到纯关键词（v3 逻辑）
 *
 * v3 保留：
 * - 双时间戳：[YYYY-MM-DD] 写入日期 + [event:YYYY-MM-DD] 事件日期
 * - TF-IDF cosine：关键词级别的模糊匹配
 * - 智能遗忘：eventDate 过期条目自动降权
 *
 * v2 保留：
 * - 时间衰减：[YYYY-MM-DD] 标注越新分越高
 * - MMR 去重：注入时剔除高度相似内容
 *
 * 设计原则：
 * - 总注入量控制在 ~3000 字符以内（避免 prompt 膨胀）
 * - 每个类别最多 Top 10 条（综合评分排序）
 * - fire-and-forget 读取，文件缺失不报错
 * - Ollama 离线时无感降级，零阻塞
 */
/**
 * 轻量版共享上下文（CLI 引擎专用）。
 *
 * 只注入 user 偏好 + 按混合匹配的 project 事实，
 * **不注入 RECENT_EVENTS**（避免 CLI 引擎把历史事件当成当前任务执行）。
 *
 * v4: async，支持向量语义检索（Ollama 离线时自动降级到纯关键词）。
 */
export declare function loadSharedContextLight(prompt: string, cwd: string): Promise<string>;
/**
 * 根据 prompt 内容，加载共享记忆上下文（完整版，含 RECENT_EVENTS）。
 * 仅供 cc 自身的 session 使用。CLI 引擎请用 loadSharedContextLight。
 *
 * v4: async，支持向量语义检索。
 *
 * @param prompt 用户原始消息
 * @param cwd   mycc 根目录
 * @returns 格式化的 context 前缀（可能为空）
 */
export declare function loadSharedContext(prompt: string, cwd: string): Promise<string>;
//# sourceMappingURL=context-loader.d.ts.map