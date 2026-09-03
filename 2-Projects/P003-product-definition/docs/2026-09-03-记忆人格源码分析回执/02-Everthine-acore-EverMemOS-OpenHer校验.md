# Everthine / acore / EverMemOS（Explore 回执要点）
## Everthine
- 三层：L1 身份 personas/default/identity.md+voice.md；L2 边界=框架内置七条 DNA（layers.py:35-145，非人格作者写）+boundaries.md；L3 当下 dynamic_context.py:241 运行时生成（时段/重逢/纪念日）。每轮 build_system_prompt 现场拼（persona.py:84-127; layers.py:176-263）。
- 模型可改写：只有 portrait.json（坐进 L1，voice 之后 DNA 之前 layers.py:246-247）、日记、facts、stage state；人格四文件全程只读（全仓无写点）。
- 节律：tick 300s（scheduler.py:96）；日记夜窗 21:00–07:59 每晚 1 篇、距上篇≥4h、对方静默≥30min（diary.py:76-78,266-288）；自画像每 7 天且需有新日记（config.py:105; portrait.py:292-298）。日记追加独立文件；自画像覆盖 live + 每日一份历史快照（portrait.py:197-222）。
- 证据链：没有——save_entry 只 6 字段无 message id（diary.py:415-425）；「不许编造」靠 prompt 散文（diary.py:481-483）。
- 写盘四件套：tmp+os.replace 原子写（diary.py:167-182）、schema 不合格整条丢、损坏文件隔离 .corrupt-<ts>（diary.py:125-137）、开关关掉字节级回旧行为（PORTRAIT_ENABLED persona.py:118-122）。「拒绝原因即日志」eligibility 模式（diary.py:238-290; portrait.py:230-298）。骨架层>人格层冲突裁决（layers.py:35-41）。
## acore
- core.md 由 CLI 向导填模板生成（init.ts:32-46; template/core.md 124 行）；预算 <2000 tokens 只是文档+doctor 告警（doctor.ts:68-82），代码不截断；遗忘规则写在 template/core.md:88-106 交 LLM 自觉；注入=写进 CLAUDE.md/.cursorrules（inject.ts:3-33），非 per turn；入库前无校验；Identity 改动需批准=散文约定（instructions.ts:13-16）；回滚在 CLI 侧 .prev/git/reset。
## EverMemOS
- 八类记忆（docs/how-memory-works.md:154-171）；/add→buffer→boundary→一次 LLM 抽 MemCell→episode 同步落 md→其余异步派生→cascade 进 LanceDB（:109-147,199-217）。
- 遗忘/衰减：仓库里没有（无 TTL/decay）；取代旧事实靠 Reflection 写 deprecated_by 软删+检索过滤（docs/storage_layout.md:198-201; reflection.md:129-131,144），默认关、cron 周一 02:00、明说无一键回滚（reflection.md:320）。
- md 为唯一真值源，.index 派生可重建；源指针到 memcell 粒度（parent_id + message_ids_json），不到字符级（lancedb/tables/episode.py:42-50; sqlite/tables/memcell.py:40-54）。检索按需 POST /search，无每轮自动注入（docs/api.md:640-645）。
## 可借/不学（agent）
- 借：骨架层>人格层显式冲突裁决；retracted 补 deprecated_by 取代指针+检索默认过滤；慢层节流（间隔门+需新素材）+每日一版快照；拒绝原因即日志；写盘四件套。
- 不学：acore 纪律全散文；只有 prompt 级可追溯无结构化 source 指针；无衰减+合并默认关+无回滚三者叠加。

# OpenHer 校验（Explore 回执要点，根 kellyvv_OpenHer）
- C1 Feel-first：部分属实——独白与回复同一次调用三段输出（engine/prompts/actor_single.md:16-23; agent/parser.py:46-69），但热路径两次串行 LLM：Critic 先（engine/genome/critic.py:130，失败重试 :198）→ Actor（agent/chat_agent.py:374/629）；stream_to_ws 不向前端发任何 chunk（ws_send 调用数 0），整段在 main.py:1174 一次下发→首字延迟=Critic+独白+全部回复。
- C2 五维驱力 connection/novelty/expression/safety/play（genome_engine.py:25）；冷却 frustration*=e^(-λΔt)，饥渴 connection+=0.15Δt、novelty+=0.05Δt，clamp[0,5]（drive_metabolism.py:74-87），λ=0.08/h（:24-28）；懒结算（来消息或 300s 心跳）。
- C3 随机网络 25D→24D→8D，seed 高斯初始化（genome_engine.py:84-88,215-221）；每轮 learn() 改 W1/W2（:306-318 ←step :355-362 ←chat_agent.py:423,686）；持久化 to_dict→genome_state（state_store.py:45-55,134-181）；**冻结/回滚：仓库里没有**；frustration 超阈值随机高斯 kick b1/b2（:327-335）=不可回滚突变。
- C4 StyleMemory 存 8D 向量+monologue+reply+user_input+mass+ts（style_memory.py:306-314），SQLite；检索 dist/√mass_eff，Hawking 衰减（:56-65,227-232），同步线性扫描（chat_agent.py:322-378）代价可忽略；「这轮搜下轮用」是 EverMemOS（chat_agent.py:465→evermemos_mixin.py:160-203，超时 0.5s）；晶化用下一轮 reward 评上一轮（chat_agent.py:302-309; prompt_builder.py:117-149：硬地板 reward<-0.5 不固化、>0.8 必固化、中间 0.4reward+0.3novelty×engagement+0.3(1-conflict)）。
- C5 种子/基线人写（persona_creation_guide.md:63-157; iris/SOUL.md:23-43）；scripts/calibrate_genesis.py 仓库里没有（文档依赖它）。
- C6 原话归因：只有 StyleMemory 晶化条目带 user_input；Hebbian/drive/frustration/relationship EMA 全部只存数值无归因（to_dict 无 provenance；genome_state 无 evidence 列；memory/engine/agent 目录 confidence|verified|evidence|provenance|audit 命中 0）。
- C7 发脾气无开关（只能调高阈值 iris/SOUL.md:35）；想你 connection_hunger_k 可设 0；主动联系 proactive_tick 300s 心跳无条件启动（main.py:98,230），全仓无 proactive_enabled；护栏冷却 4h+待发上限 3+dedup（state_store.py:351-362）。
- C8 三层记忆属实；本地事实层 add_facts 零调用方（memory_store.py:104-131）；EverMemOS 返回的 atomic_fact/profile 直接拼进 prompt 无置信度/时效/冲突消解（evermemos_client.py:370-374,398-405,682-702）。
- 借：晶化滞后一轮+复合门控（带 user_input 原文）；Hawking 质量衰减做遗忘曲线（基线不蒸发、后天增量蒸发）。排除：随机网络+每轮 Hebbian（不可审计不可回滚）；串行 Critic+全缓冲输出+发脾气+无开关主动联系（若做主动播报只借出站护栏 state_store.py:228-362）。
