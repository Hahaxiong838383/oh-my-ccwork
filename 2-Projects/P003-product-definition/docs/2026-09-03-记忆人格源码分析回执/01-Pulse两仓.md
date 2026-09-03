# Pulse 两仓（Explore 回执要点，refs 见原回执）
## Ruby2025/Pulse（Telegram 陪伴 bot ~5.5k 行）
- 内核 character.yaml core_personality 只读进 system prompt，全仓无写点（core/bot.py:824）；表层 character_profile_surface.json 仅 3 字段（昵称权重/表达方式权重/话题反应），唯一写点 GrowthManager._apply_L3_drift（core/growth.py:184）；yaml 的 surface_personality 是死字段。
- 积压池 data/growth/pressure_pool.json：LLM 判 {direction, base_weight1-5, event_type}，actual=base×type_weight（日常1/偏好2/情感3/冲突4/重大5），按 direction 归并累加；阈值 L3_weight_threshold 30 或 L3_count_threshold 15 任一即改表层（growth_config.json:2-18）；decay_lambda 0.04 但 apply_decay() 全仓无调用方=衰减从不发生（growth.py:129）。触发=每轮回复后 daemon 线程，最多 2 次 LLM（检测+改写，growth.py:69-75,174-177）。
- 零 token 状态：energy/mood/social_need 0-100（state_core.json），mood=mood*0.7+axis*0.3（α=0.3 EMA），低气压概率 0.02×(1+(1-mood/100))；结果文本注入每轮 prompt（state.py:116-135,319-340,455-475; bot.py:781,847）。
- 过门/回滚：无。LLM JSON → _deep_update 直接落盘，无 key 白名单/schema/快照/撤销；仅 append-only drift_log.json 200 条且不带肇因原话（peak_event 未进 log）（growth.py:178-210）。
- 主动联系默认：冷却 30min/日 4；关注模式 20min/8；思念日 1；48h 无联系 closeness−5；亲密三阶段 closeness≥30&trust≥20→熟悉，≥70&≥50→亲密（behavior_config.json:29-36,71-73; character_config.json:39-58）。关闭=connector.type=none（无独立 proactive.enabled 开关）。
## wanghong5233/Pulse（带 governance 的 Agent Runtime）
- CORE 保护靠 key 白名单非文本标记：CORE_SOUL_KEYS={assistant_prefix,principles} 拒改，payload 过滤到 MUTABLE_SOUL_KEYS={tone,style_rules}（core/soul/governance.py:29-30,341-365）。[CORE]/[MUTABLE] 前缀仅 _split_tagged_values 解析，但 values 整列表被赋给 soul.principles（CORE）→ 标 [MUTABLE] 的实际改不动（core_memory.py:157-158）——文档语义≠代码语义。
- 偏好过门五段：LLM confidence → _MIN_CONFIDENCE 0.4 → supported_ops 白名单 → CORE_PREF_KEYS 分流 → 风险推断映射 mode（domain_preference_dispatcher.py:104,201-240; evolution.py:94-106,397-444）。
- 治理三态 autonomous/supervised/gated + 风险等级映射（config/evolution_rules.json:1-20）；supervised 产 change_id 挂起，approve_change 落地，rollback 按 before 还原，audit ~/.pulse/governance_audit.json 上限 1 万；规则版本库 list/get/diff/rollback（governance.py:590-712,806-817; rules_versioning.py:26-120）。审计条目只存 before/after/updates 不存原话（governance.py:285-288）。
- evidence 一等公民：DomainPref.evidence(原文片段)+confidence 贯穿 extractor→dispatcher→事件；archival 事实 evidence_refs JSONB（preference_extractor.py:68-76,216-221; archival_memory.py:83,122,138）。
## 可借 / 风险（agent 结论）
- 借：key 白名单代替文本标记；积压池+双阈值节流改画像；置信度过门+evidence+SKIPPED 事件；三态 mode×风险映射放 JSON；零 token 三轴状态机选当天音频语气。
- 风险：Ruby 表层写入无白名单无快照；decay 死代码=阈值必被闲聊击穿；wanghong 标记与机制脱节。
