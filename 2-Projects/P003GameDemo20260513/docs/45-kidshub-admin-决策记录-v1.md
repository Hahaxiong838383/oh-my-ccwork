# KidsHub Admin 后台 · 决策记录 v1（ADR）

> 创建时间：2026-06-30
> 维护范式：Architecture Decision Record（ADR）。新增 KidsHub Admin 架构级变更时，在文末追加 `ADR-NN`。
> 用途：让团队产品 / 工程师 / 未来的我 一眼看懂「为什么这么做」，而不只是「做了什么」。
> 关联记忆：[A canonical] `project_kidshub_workbench`（实现细节）+ `0-System/task-log.md`（时间线）。

---

## ADR-01 双标签（主题 + 情绪）+ 采纳子类

- **Status**：✅ Adopted（2026-06-30，PR #9 merged，公司侧已部署）
- **Context**：Issue 看板原只有状态四态（已收到/评估中/已采纳/金点子库），admin 无法对反馈归类，主题池是 mock。
- **Decision**：
  1. feedback_items 加 `theme`（13 项预设）+ `emotion`（5 项）+ `adoption_kind`（普通/重点，仅 status=已采纳 时生效）三列
  2. **纯人工手标，不接 LLM** —— admin 在抽屉里下拉编辑
  3. status 枚举不动（不破现有 4 列看板），子类用独立字段
- **Alternatives**：
  - Gemini 落库即标（公司侧网关）→ 否：~1-2s 延迟破充场用户流，且生产数据需人工校验
  - Gemini 看板拉取时懒标 → 否：仍需 LLM 调用成本，且数据不一致（不同次拉取可能标不同）
  - DeepSeek（个人站同源） → 否：跨站同步成本
  - 把已采纳拆成 5 个 status 枚举 → 否：破现有看板列结构 + admin 心智负担
- **Consequence**：
  - admin 手工开销可控（每条反馈 ~5s 归类）
  - 数据干净可控，主题池可做真聚合
  - 后续若量大可升级为「LLM 自动标 + 人工校验」混合模式（不破当前架构）
- **Refs**：commit `2e4d772fa` / `7d4ba1c76` · PR #9

---

## ADR-02 主题词表演化策略（路 A → 路 B）

- **Status**：🔄 Evolving（路 A → 2026-06-30 升级为路 B，本 commit）
- **Context**：13 项主题词表硬编码在 server + admin-proto 两处，admin 想加 / 改 / 删主题需要找 cc 改代码。
- **Decision**：
  - **Phase 1（路 A，2026-06-30 上午）**：硬编码 + 你说我改。适合词表稳定。`FEEDBACK_THEMES` 数组同步两端 + `themeChipColor()` 配色。
  - **Phase 2（路 B，2026-06-30 下午，本 commit）**：升级为后台可编辑。`themes` 表 + 4 CRUD endpoints + 管理页（左栏 nav 独立页）。
- **Alternatives**：
  - 一直停留路 A → 否：川哥明确要求自助
  - 路 A 直接做 admin 配置 UI（写 JSON 文件） → 否：文件并发 + 持久化难
- **Consequence**：
  - 路 A 用了一天就升级，避免了「路 B 半天工程」的延迟成本
  - admin 自助维护，cc 不再是瓶颈
- **Refs**：commit `7d4ba1c76`（路 A）· 本 commit（路 B）

---

## ADR-03 产品开发看板（DevItem）

- **Status**：✅ Adopted（2026-06-30，PR #10 merged）
- **Context**：admin 把已采纳反馈升级为开发条目，需要走「规划/开发/上线」流转 + 致谢闭环。Issue 看板止于「已采纳」，没下文。
- **Decision**：
  1. 新建 `dev_items` 表 + `dev_item_feedbacks` 多对多关联表
  2. 三态流转 `规划中 → 开发中 → 已上线`
  3. **双入口**：开发看板「+ 新建」+ Issue 抽屉「升级为开发条目」（promote）
  4. 致谢只打标（`thanks_sent_at` 时间戳），不真推送 → 实际推到孩子端是独立任务
  5. 自动聚合 `source_themes` + `representative_quote`，admin 改后 lock=1 不再覆盖
- **Alternatives**：
  - 只开发看板入口手建 → 否：与 Issue 流脱节，admin 心智割裂
  - 致谢真推送到孩子端 → 否：需设计孩子端接入点 + 周期长，先打标看效果
  - 单对一关联 → 否：「N 个孩子提过同一问题」必须多对多
- **Consequence**：
  - admin 闭环：孩子提点子 → 采纳 → 升级 → 上线 → 致谢（可视）
  - 反向查 `findLinksByFeedbackIds` 让 Issue 抽屉看到「已进入开发看板」chip
- **Refs**：commit `ccfe590bc` · PR #10

---

## ADR-04 多人聚合（手工合并）

- **Status**：✅ Adopted（2026-06-30，PR #11 merged）
- **Context**：同问题被多个孩子各提一遍，看板刷屏；同时多条反馈对应一个开发条目，逻辑应聚合而非散乱。
- **Decision**：
  1. feedback_items 加 `parent_feedback_id` 列（单层，禁嵌套）
  2. **手工合并**：admin 在抽屉里「+ 合并子项」（默认列出同 theme+emotion 推荐候选）
  3. 看板 list() 默认 `onlyParents=true`，只渲父项
  4. 5 重校验：`cannot_merge_self / child_has_own_children / parent_not_found / parent_is_child / child_not_found`
  5. **dev-items 联动**：`expandWithChildren()` 在 promote 父项时自动带走所有子（反向查每个子都看到「已进入开发看板」chip）
- **Alternatives**：
  - theme+emotion 自动聚合 → 否：一组可能混多个不同问题（精度低）
  - 多层嵌套（孙子级） → 否：心智复杂，UI 难展开
  - 全文本相似度算法 → 否：需 LLM/embedding，反 ADR-01 决策
- **Consequence**：
  - 看板从「按反馈」转向「按问题」，admin 视角更清晰
  - promote 联动让多孩子的同一诉求一次进开发管线
- **Refs**：commit `c4c4ca40a` · PR #11

---

## ADR-05 主题 chip 卡片可编辑（popover inline）

- **Status**：✅ Adopted（2026-06-30，本 commit）
- **Context**：admin 改主题必须进抽屉 → 2 步操作。看板上一眼能看到主题不对，但要点开改不直觉。
- **Decision**：
  1. 卡片 theme + emotion chip 加 `@click.stop`（防触发抽屉打开）
  2. 点击弹 `el-popover` 内嵌选项面板（主题 13 项 + 情绪 5 项）
  3. 选完即时 PATCH（复用 `setRealTheme()` / `setRealEmotion()` 函数，保乐观更新 + 失败回滚）
  4. guest 模式 chip 仍可见但 popover 不弹（点击 no-op）
- **Alternatives**：
  - 点 chip 进抽屉自动聚焦主题字段 → 否：仍 2 步
  - 卡片 chip 可自由输入自定义主题 → 否：破枚举约束 + 同义词碎片化（"夜航内容" vs "夜航·内容" 算两组）
- **Consequence**：
  - admin 改主题从 2 步 → 1 步
  - 主题池真聚合即时联动
- **Refs**：本 commit

---

## ADR-06 主题词表后台管理（themes 表化）

- **Status**：✅ Adopted（2026-06-30，本 commit）
- **Context**：ADR-02 路 A 不可持续，每次加 / 改 / 删主题都找 cc 改代码 + 部署，admin 自助是刚需。
- **Decision**：
  1. **数据架构 C**（中文 id + display_name 同步）：feedback.theme 仍是字符串（'功能类'），themes 表存元数据 id（=display_name）/ color / sort / active / system；改名时事务里联动 UPDATE feedback.theme = 新值
  2. **system=1 锁**：「未分类」「其他」不可删 / 不可改 id；可改 color
  3. **软删**：active=0，feedback 引用仍渲染（chip 灰 + "(已禁用)"），admin 可改归类
  4. **管理入口**：左栏 nav 新增「主题词表管理」独立页（el-table 行内编辑 + 排序 + 增删）
  5. **启动 seed**：首次启动写入 13 项预设作为种子（已存在跳过，幂等）
- **Alternatives**：
  - 数据架构 B（id 与 display_name 分离） → 否：需 migrate 24 条历史数据，过度设计
  - 完全平等可删 → 否：admin 误删系统级主题后新反馈无兜底
  - 管理页放 Issue 抽屉里「设置」按钮 → 否：嵌抽屉体验差
- **Consequence**：
  - admin 自助维护词表，cc 不再瓶颈
  - 改名安全（事务保证）+ 软删兜底（不丢历史）
  - 主题池真聚合按字符串值分组（与新词表 id 一致）行为不变
- **Refs**：本 commit

---

## ADR 范式（新增 ADR 时复制下方模板）

```markdown
## ADR-NN 标题

- **Status**：Proposed / Adopted / Deprecated / Superseded by ADR-MM
- **Context**：当前问题/痛点
- **Decision**：怎么做（要点列表）
- **Alternatives**：备选方案 + 否决理由
- **Consequence**：影响（正/负）
- **Refs**：commit hash / PR # / 相关 ADR
```
