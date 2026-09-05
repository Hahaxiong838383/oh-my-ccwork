# 小可 worker 加能力：现状对撞与快速起效清单（2026-09-05）

> 结论先行：**最快见效的不是接 MCP / ACP，而是把服务端已有的真值数据当「快工具」注入大脑 prompt**——零 APK、零 worker 改动、pm2 当天生效。工具层的家在服务端 `custom-llm`，worker 只做「时机 + 播放 + 设备执行」。
> 证据来源：17 路只读分析（5 路读 worker/服务端/产品/生态，3 视角提案，8 条逐条对撞，1 路查漏）。file:line 均已核对；生产真值只读普查一次（telemetry.db，2026-09-05 19:59 CST）。川哥转来的那份「快工具/慢专家/MCP/ACP」框架按开发者语音助手写的，本文只取其分类法，编码 agent 部分对儿童学习桌不适用。

## 一、现状四条硬事实（决定了怎么加）

| # | 事实 | 证据 | 含义 |
|---|---|---|---|
| 1 | worker→大脑是 OpenAI 兼容 SSE，服务端**只取 user/assistant 角色、只回 delta.content**；worker 自带的 system 指令在大脑路上被丢弃 | `rust-worker/src/llm.rs:82-100,392`；`server/src/routes/custom-llm.ts:79-85` | 工具协议/安全策略写在 worker 对生产无效，必须写在服务端 |
| 2 | 两侧**零 function calling / tool_call**；现役「工具」只有两种：pre-LLM 确定性短路（style-intent / exit-intent / onboarding）与带内标记 `[[DEV:n]]` | grep -c 两侧 = 0；`device-brain-prompt.ts:78` | 加能力先沿用这两种形态，不引第三种 |
| 3 | worker 主循环单 `tokio::select!`，**禁止 await 网络**（5 s 无心跳关房），`hard_abort` 会 abort 整轮任务 | `pipeline.rs:706-833,805-813,1662`；`job.rs:141-171` | 有副作用的工具绝不能放 worker；同轮工具只能是「服务端拼 prompt 前同步读本地数据」 |
| 4 | 产品定义 V3.2 八张卡有 5 张依赖「状态真值」（卡 2/3/5/6/8），但 `{device_state}` `{focus_today}` `{focus_yesterday}` 占位符**零注入**，也零天气/搜索/闹钟代码 | 全仓 grep 计 1（仅 KB 文案）；V3.2 :90-97,:156-158 | 产品已承诺却空着的，就是最该先补的 |

儿童硬约束（B.4 幻觉 / B.5 防依赖 / B.6 七禁区 / 「ASR final→首 token 禁同步检索」）直接否定：开放网页搜索、同步外部检索、写作业中的主动播报、代写作业型问答、「危险操作靠语音确认」（9-02 方案已改成家长授权面）。
一条隐形约束：服务端 race 的 `LLM_RACE_MAIN_GRACE_MS`（代码默认 0，注释称生产 800，**未核**）——每多一段同步注入都在吃兜底窗，超窗被裸 doubao 盖掉 = 注入白做。所有注入上产前先核这个值。

## 二、第 0 步（半天，不需拍板，先上）
1. **语料普查**（只读 SQL）：生产 conversation.db 近 30 天按六族关键词（几点/星期/几号｜灯/亮/暗/音量/声音｜多久/专注/学了｜上次说的/建议｜天气｜讲故事/儿歌）统计 user 轮次 + 去重 SN，排除探针与 003 调试账号。后面的顺序从猜变成数（目前唯一有数的是专注族：5/2364 轮）。
2. **「零数据护栏」一行**：`prompts.ts:15` 的【真实性】红线现只覆盖「收益/进度/变化/承诺」，扩到时间日期、设备状态、专注分钟、建议进度、天气——查不到就说查不到，绝不编。这是现状最大的幻觉口子，也是所有后续注入超窗/无行/管线死时的兜底。
3. **给 codex 开工单**：生产 telemetry.db `focus_segment` 事件 0 条、daily `focus_ms` 全 0（合同 §3.3 Godot `focus_mode` 未镜像给 Launcher）。卡 8 下半的长杆，先启动。
4. **核 64.90 `rust-worker.env`** 的 `LLM_BASE_URL` 与 `LLM_RACE_MAIN_GRACE_MS`（服务端 `DEVICE_INTENT_OBSERVE=1 / LLM_PROVIDER=race / TELEMETRY_SN_ALLOWLIST=空` 本轮已核）。

## 三、一周内能起效的两件事（按顺序）

### 1. 时间锚注入（1 天，服务端）——同时是后两条的「模子」
- 孩子问「今天几号 / 星期几 / 是不是周末」今天只能编。修法：`prompt-orchestrator.ts buildChildMemoryBlock` 的 dataLines 加一行「【现在的时间·数据】2026年9月5日 星期六 下午」，**只到日期+星期+时段，不带分钟**（每分钟变会打掉上游 KV 前缀缓存，`pipeline.ts:366`）；固定 UTC+8（复用 `shanghaiHour` 写法，禁进程时区）。
- 放在 memory 层内 = `custom-llm.ts:133` / `pipeline.ts:381` / `buildDeviceLayers:135` 三处自动同源（admin 拼接可视化看到的 = 设备收到的）。要同步改两个测试锚：`isolation.test.ts:135` 五层键、`orchestrator.test.ts:20-22` 空注入断言。
- 一次把「逐轮数据段」的公共件做完：dataLines 形态 + policy 压制 + admin persona-probe 锚 + `custom-llm.ts:129` 统一日志标签 + env 开关模板（`TIME_ANCHOR_INJECT=1` 默认关，回滚=置 0 + restart）。后两条照抄。
- 范围外：假期倒数、农历、生日倒数拆二期（农历可用 Node `Intl.DateTimeFormat('zh-CN-u-ca-chinese')` 不必引库，生产 Node 版本未核；生日只存 YYYY-MM）。约定「明天」的推算服务端已自算（`memory-item-store.ts:81-105`），不依赖此项。

### 2. 设备状态真值回答（2.5–3 天，服务端，卡 8 上半）
- 「灯开着吗 / 亮不亮 / 暖光还是冷光 / 声音大不大」→ 关键词门 → `telemetry-store.ts:219 latestSnapshot(sn)`（in-process SQLite）→ 自成区块注入（不塞记忆 policy 块，:262「不逐字复述」与「照实说档位」冲突）→ 超新鲜度窗**不注入并回落兜底句**「小可还查不到灯的状态呢」。新鲜度 ≤60–90 s（3× 上报周期），不用 10 min 在线窗。
- **时序对撞**：快照 30 s 一报，「刚调完 5 s 就问」会高置信答错——注入前查最近一条 `device_command` 事件，快照早于命令则不注入。
- **只注入灯开关/亮度档/色温模式**，排除 `present / lid_open / focus_*`（暴露孩子实时在场与开盖，且注入段随 prompt 发往 DeepSeek + 火山，与所有 prompt 同路径，不是「零外发」）；像距排除（003 自 9-02 恒 12，失真单未闭环）；音量先跑负锚（语音「音量大一点」succeeded 后下一条快照 `volume_percent` 是否变，003 恒 35 分不清「没人动」和「冻结」）。
- 档位换算家长端已有（`App.tsx:96-104` 低/中/高、五种色温模式），缺的是产品拍板：话术「亮度 80% / 4000K」数据上不可实现，改档位词。
- 覆盖面：只有端侧遥测开关打开的设备（`p003_device_telemetry_enabled` 归 codex，现 003/0010 验过）；「孩子」是内测家庭。验收通道：admin 无 led/volume 面板，加一个只读「设备最新快照 / 日聚合」视图（0.5 天）或 sqlite 直查；「真被孩子用到」以 conversation.db 非调试账号命中轮为准。
- 坐姿正向表述可并入同一模块（+0.5 天）：`dailyRange` 的 `correct_rounds/deviated_rounds` 有真数据（003 9-05 当日 24/17），但卡 7 禁「讲坐姿大道理」，只做正向不报次数，等产品话术。

## 四、第二梯队（零 APK，需产品口径）
- **语音提建议落库 + 「我上次的想法怎么样了」四态回答**（卡 5，约 2 天，**必须捆绑**）：设备房今天零反馈入口，且设备账号与家长账号是两条身份线（`device-brain-prompt.ts:41-45`），单做进度回答注入永远为空。落库 `feedbackStore.add(source='rtc')`、admin 四态看板、30 s 去重都在；状态只走枚举映射，note/theme/emotion 不进注入。先决：设备房采集话术 + 隐私日志口径（原话前 30 字）。家长端反馈数据目前是 mock，别拿它当同源。
- **昨日对话回顾 / 约定到期提起**：不是新能力——重逢「上次聊到」注入（`prompt-orchestrator.ts:160-166`）与 promise due 渲染（`:359-371`）已在产；只剩「未来 due → 还有几天」一小段增量，随时间锚顺手做。

## 五、专注时长回答（卡 8 下半）：排后，等端侧
server 侧 1–1.5 天，但生产 `focus_segment` 0 条、家长 H5「今日专注」恒 0（两个 0 对得上不叫同源）。现在上 = 对坐了两小时的孩子说「今天刚开始」。判据：生产 `device_telemetry_event` 出现 `type='focus_segment'` 且当日 `focus_ms>0`、家长 H5 非 0，再按第三节模板写注入。

## 六、真正的「快工具」（要网络、≤2 s）：第三梯队
- 天气/穿衣（和风每月 5 万次免费）、儿童字词（离线 chinese-xinhua 数据；有道少儿词典需商务开通且禁缓存）。价值中等，先做前置件：**工具入口过滤**（儿童分级 + 敏感词 + 来源标记）与**工具流水可观测**（耗时/命中/失败，不留原话）。
- 实现形态仍是服务端有界同步调用（照 `companion-kg.ts:113-126` 的 ≤400 ms 模板），不是让 LLM 决定调不调；本地毫秒级读不需要「口头占位」——需要占位本身说明它不是快工具（filler task 桶也不是零成本：改 boost + 讯飞重合成 + worker 重部署）。
- 只有当工具需要 LLM 抽参数时才上原生 function calling：火山 doubao-seed-2.0-lite/mini 已标「工具调用」+ 流式 tool_calls（docs.volcengine.com/docs/82379/1262342）；DeepSeek 流式下有「工具调用退化成纯文本」的 open issue；Gemini 兼容层流式缺 index。服务端四个 provider 都不透传 tools，共七处触点。
- 上 FC 前 worker 必须补四处：首 token 迟到→再喂一条 task 桶承接（`pipeline.rs:2336` 的 `delta_rx.recv()` 外套 timeout）；投机请求与正式请求同 endpoint 无标记（`llm.rs:609-614`）会让服务端工具副作用被投机提前触发；race grace 覆盖工具耗时（`llm.rs:477-480`）；reqwest 30 s 总超时与赛马败者 abort（`llm.rs:537,575`）。「赛马/投机/打断全部现成继承」对有副作用的工具是负资产。

## 七、慢专家（后台 + 回灌）：不在本轮
学习计时器 / 长故事后台生成 = backlog B1。唯一必须动 worker 的一类：缺「无用户轮时主动开播的安全窗」与「用户在说时阻塞」（`turn.rs:23` 私有，Orchestrator 拿不到），DeferredSay 单槽新覆盖旧、hard_abort 清槽。效果慢、风险高，等前两件跑稳再立项。

## 八、不做 / 不适用于儿童学习桌
开放网页搜索；编码 agent / ACP / Grok Build；MCP 市场工具；危险操作语音确认（改家长授权面 + 参数白名单）；迁 Pipecat / LiveKit Agents（语音环已自研且在产）。
**MCP 协议本身**：所有工具都是自家 server 内部函数读本地 SQLite，跨进程 RPC 只加延迟与故障点；等外部工具 ≥3 个再上（服务端 `@modelcontextprotocol/*` 2.0、worker 侧 rmcp 3.2 都已成熟）。

## 九、需要川哥拍板的三件事
1. 设备状态话术改档位词（放弃 80% / 4000K），坐姿正向要不要说、怎么说。
2. 时间锚与「零数据护栏」是否上（护栏零风险，建议直接上）。
3. 专注段端侧缺口交 codex 工单（Godot focus_mode → Launcher → focus_segment）。

署名：cc（Claude）| 2026-09-06 00:22 CST
