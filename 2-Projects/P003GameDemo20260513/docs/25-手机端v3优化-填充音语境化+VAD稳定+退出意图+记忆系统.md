# docs/25 · 手机端 v3 优化 —— 填充音语境化 + VAD 稳定 + 退出意图 + 记忆系统

> 川哥真机测 v4(VAD+填充音预加载)后反馈 4 问题,要 team 模式调研市面 agent 给最优方案 + 分析记忆系统。
> 方法:team 三发(grok-4.3 + codex gpt-5.5 + gemini-3) `/tmp/r-{grok,gpt,gem}.md` + market 联网调研(9+ 语音 agent 产品 + ACM CUI'25 论文 + 火山官方文档) + **cc 源码逐层验证**。
> 证据标签:【已验证=读源码/读原文】【待验证=需 E2E/实测】【推断】。
> 日期:2026-06-20。

---

## 总览:三方高度收敛 + cc 源码定根因

| 问题 | 根因(cc 已验证) | 方案共识 | 优先级 |
|---|---|---|---|
| 4 记忆 | 移动端 prompt 不带 lore + 无 cardId | 不重构,补 3 注入缺口 | **P0**(明确 bug) |
| 2 VAD | 前端能量 VAD 驱动判停,火山 server VAD 没开 | 火山语义判停当主力,前端降兜底 | **P0**(最高 ROI) |
| 3 退出意图 | 无此功能 | L1 白名单 + L2 LLM intent + L3 idle | **P1** |
| 1 填充音 | 纯随机 + 首轮预加载未完成 | 3-4 类规则分类 + 等待门控 | **P2**(锦上添花) |

---

## 问题4:记忆系统(根因已验证 · 先讲因为川哥列为最严重)

### 根因(代码级已验证,非推测)
川哥现象:「读写台记忆都在,方舟游戏世界记忆大多没了」。三处源码事实:
1. 【已验证】移动端语音补发 prompt 用 [`getComposedPromptNow()`](../apps/web/src/kidshub/store/kidshub-store.ts) —— 调 `composeSystemPrompt` 时**不传 `lore` 参数**(对比体验台正常对话用的 `getComposedPromptSampled()` 是带 lore 的)。
2. 【已验证】移动端语音 `sceneId=null`、无 `activeCardId`,而 lore L2 素材是按 `cardId` 从 `CARD_LORE_MAP` 选的 → 即便走 sampled 也选不到。
3. 【已验证】读写台玻璃光学**写死在 `GLOBAL_SYSTEM_PROMPT`【世界观】段**(川哥钦定 2026-06-13),GLOBAL 移动端必带 → 读写台幸存。

结论:**方舟游戏世界的「血肉」(WORLD_CORE 的方舟使命/核心循环/三句信念 + lore-sections 的藏品/光环/生态缸演变)在手机端从来没注入过**。不是被学习知识库「覆盖」,是 lore 系统是给体验台卡片场景设计的,语音是另一条路从没接上。
附:【已验证】`memory-extractor` 只抽孩子画像(昵称/兴趣/性格/情绪),**不抽方舟剧情进展** → 小可也不可能记得「我们一起在方舟的冒险」。

### 方案(三方共识:demo 不重构,补 3 缺口)
1. **移动端常驻注入 WORLD_CORE(L1)**:不依赖 cardId,~150-250 字,TTFT 影响可忽略。修复方舟使命/核心循环/三句信念缺失。
2. **VOICE_DEFAULT_LORE_PACK**:无 cardId 时注入「语音默认精选集」—— 挑 3-5 个最具故事张力、孩子最易提及的方舟核心设定(方舟飞船/能量核心/星域探索/生态缸/小可是队友),**不全量轮播**(控 500-1000 字内)。可选:有 ASR 文本时按关键词(恐龙/宝箱→恐龙星域 lore)轻量选 L2,demo 不用 embedding。
3. **尾部人设锚点升级**:现有 ~80 字锚点只钉「小可人设」,要**加钉方舟世界关键词**(方舟飞船/能量核心/星域探索/小可队友),且锚点**位置固定在最末尾**(curriculum-kg/ai-literacy 之后),抵消学习知识库的 recency 稀释。

### ⚠️ 决策点(要川哥拍板):事件记忆层做不做
- gemini 方案(最轻):扩 `memory-extractor` 加 `game_progress` 字段,LLM 抽「孩子方舟进展」(如"已通关恐龙星域")存 DB,后续注入。低成本,90% 效果。
- gpt/grok:demo 阶段先修静态注入即可,事件记忆 Phase1 再做。
- **cc 建议**:先修静态注入(P0,确定收益),`game_progress` 作为 P1 可选(如果川哥要小可「记得冒险经历」的陪伴感再做)。

---

## 问题2:VAD 判停不稳(根因已验证 · 最高 ROI)

### 根因(代码级已验证)
1. 【已验证】火山用大模型流式 ASR(`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`)。
2. 【已验证】**现状 `asr.final` 由前端能量 VAD 判停驱动**:前端 VAD 判停 → `audio.end` → server `asr.finishAudio()` 发 `audio_end:true` EOF → 火山返回 final(volc-asr.ts:137-145 + pipeline.ts:138-141)。**火山自身的语义判停能力完全没用上**。
3. 【已验证】前端能量 VAD 不稳根因:阈值相对 noiseFloor(`silenceTh=max(noiseFloor*1.5, 0.008)`),背景噪稍高→silenceTh 抬高→判不到静音→拖 6s 兜底;安静则快。**环境噪决定快慢** = 川哥「时快时慢」。叠加 noiseFloor 说话期冻结 + 首 200ms 未收敛。
4. 【已验证·关键】**`isFinalPayload` 已经检测 `definite` 字段**(volc-asr.ts:268)—— 接收侧基础设施就绪,只差 ASR start payload 开启火山 server VAD。

### 方案(三方共识:火山语义判停当主力,前端降兜底)
1. **开火山 server VAD**:在 ASR start payload(volc-asr.ts:64-78 `request`)加 VAD 参数,让火山在用户说完后**主动吐 `definite=true` 句尾事件** → server 收到主动触发 onFinal(不再等前端 audio.end)。判停由火山语义 VAD 主导(懂「思考停顿 vs 说完」,比纯能量稳)。
   - 火山参数(market 调研【待验证】,JS 文档渲染不出,名字确认/默认值待实测):大模型 ASR `vad_segment_duration`(默认 3000ms,太长)、`end_window_size`/`end_smooth_window_ms`;或 RTC 方案 `AIVAD=true` + `SilenceTime`。
2. **前端能量 VAD 降「抢跑兜底」**:保留 AnalyserNode RMS,静音阈值 1800ms→~800-1000ms 当「最快可能说完」提示,**最终判停以火山 definite 为准,语义信号优先**(防两路竞态:加防抖 + 优先级)。
3. **童声自适应超时**:基础静音阈值 ~1000-1200ms(比成人 600-800ms 长,孩子停顿长);高置信判完时最小静音可短(~300ms),不确定回退长静音(~2000-2400ms);ASR partial 以「然后/还有/因为」连接词结尾时延长等待。
4. **加判停日志**:`rms/noiseFloor/asrPartial/asrFinal/finishReason(local_silence|asr_definite|timeout)`,否则「不稳定」无法复现。

### ⚠️ 关键待验证(落地前硬门槛)
- 火山大模型 ASR 的 server VAD 参数确切名 + 默认值 + **definite 事件真实判停延迟**:**必须 E2E 实跑**(开 `DEBUG_ASR=1` 看火山原始帧有没有主动吐 definite)再定阈值。这是 P0 第一步。

---

## 问题1:填充音语境化(锦上添花 · 错配风险高需克制)

### 根因(已验证)
【已验证】纯 `Math.random` 选 8 条,与语义/情绪无关;首轮预加载挂首次手势 `unlockAudio`,第一轮未 decode 完 → 川哥「刚开始没加载,聊几轮才正常」。

### 方案(克制版,CUI'25 学术铁律)
- ⚠️ **反直觉铁律**(ACM CUI'25 arXiv:2507.22352,链路与小可同构,agent 读全文):**LLM 首字快(<1.5s)就别放 filler,否则更假/creepy**;filler 只在首字真慢(>4s)时显著改善体验。→ **必须加「等待计时器」门控**:用户说完起 600-800ms 定时器,LLM 首字先到就不放,定时器先到才放。
- ⚠️ **业界真相**:生产框架 filler 绝大多数仍随机抽,真正「语境化」只到「按工具/状态分桶」粒度,**没有按情绪细分的成熟实现**(学术界明说是未解难题)。→ 川哥方向对但要克制,**3-4 类够,错配比随机更尬**。
- **分类**(对前端已收的 ASR 文本做关键词规则,<5ms,不用小模型):
  | 类 | 触发 | filler 桶 |
  |---|---|---|
  | 知识/查询(pensive) | 为什么/是什么/怎么/哪里 | 让我查查/我想想哦 |
  | 难题/思考(pensive+共情) | 句长/难/不会/帮我想 | 这个有点难哦,让我好好想想~ |
  | 闲聊/情感(acknowledgment) | 招呼/情绪词/短句 | 嗯~/哈哈 |
  | 兜底 | 不匹配 | 现有 8 条中性随机 |
- **现有 8 条直接打标签**就能做第一版(gpt 给了映射),不必新录。类内随机不再全局随机。
- **首轮兜底**:unlockAudio 立即优先 preload 1 条最短 neutral fallback;分类音频没 ready 就播 neutral;都没 ready 则首轮静默(别临时 TTS 生成,比 LLM 还慢)。
- llm.delta 到了 50-100ms fade-out,不硬切。

---

## 问题3:退出意图识别(用户不想聊→停对话+退唤醒态)

### 现状
【已验证】无此功能。多轮中孩子说「不想聊了/拜拜/别说了」不识别,继续等接话。

### 方案(三方共识:三层判退出,不靠纯 LLM)
- ⚠️ **校准**:end-of-turn(问题2 判一句说完)≠ end-of-conversation(问题3 判想结束),方案不通用。
- ⚠️ **Vapi 坑**:纯 LLM endCall 要么不触发要么过早吞掉告别 → 不能纯靠 LLM。
- **L1 端侧告别词白名单**(~0ms):`拜拜/再见/不聊了/不想聊了/别说了/我走了/我去睡觉了/先这样`。**排除 `不要/不/我不`**(否则"我不要吃青菜"必误判)。
- **L2 主 LLM 输出 `intent` 字段**(0 额外往返,比独立 [EXIT] 标记优):让主 LLM 在每轮回复 JSON 多带 `intent: continue|wind_down|exit`(结构化输出,非 function call),捕捉 L1 漏的语义退出(「今天就到这吧」)。
- **L3 idle 超时兜底**(Pipecat 升级式):静默 8-10s→温柔提醒一次→再 8-10s 无应答→自动告别退出;一开口重置。
- **误触发规避**:歧义否定(「不要/我不想」无明确告别词)→不直接退,L2 模糊时反问一次(「想休息一下,还是换个话题呀?」);对话开头 <2-3 轮否定词当内容。
- **优雅告别**:1 句短暖邀请回来(「小可先去休息啦~想我了就喊'小可小可'」),`sayDirect` 播完再切状态。
- **退出链 = 唤醒进对话链反向走**:播告别→停 TTS/录音(复用 barge-in)→释放麦(复用 JS Bridge pauseWake)→重启唤醒监听→idle。复用 [[feedback_p003_voice_v2_prompt_wake_optimization]] 的 playCue/sayDirect/pauseWake。

---

## 实施优先级(按 ROI)

- **P0-a 记忆注入修复**:移动端常驻 WORLD_CORE + VOICE_DEFAULT_LORE_PACK + 尾部锚点钉方舟词。纯前端 + server prompt,无外部依赖,确定收益。
- **P0-b VAD 火山语义判停**:先 `DEBUG_ASR=1` E2E 实测火山有没有主动吐 definite + 延迟,再开 server VAD + 前端降兜底 + 童声参数。最高 ROI 但需实测火山参数。
- **P1 退出意图**:L1 白名单 + L2 LLM intent + L3 idle + 退出链。复杂度低体验收益大。
- **P2 填充音语境化**:3-4 类规则 + 等待门控 + 首轮兜底。锦上添花,错配风险需克制。

## 共性铁律(三方一致)
1. 语义信号 > 能量/随机信号(判停、判退出、判 filler 都优先「理解」)。
2. 本地规则兜底 LLM,不依赖纯 LLM 时序(非确定性,端点/退出都被坑过)。
3. 童声特殊性(阈值/语料/filler 收益)全部「待真机验证」,别拍脑袋定参数。

## 待验证缺口(诚实标注,勿当事实)
- 火山 `vad_segment_duration`/`end_window_size`/`AIVAD` 确切默认值 + 判停延迟 → E2E 实测。
- 5-10 岁儿童真实退出语料 + 童声 filler 实证收益 + 童声 VAD 阈值 → 真机小样本录音校准。

## 约束(铁律)
- 儿童 5-10 岁;demo 阶段不管隐私。
- 个人站 server 冻结(只改公司侧 server + 前端 Web + Android 壳)。
- 麦克风互斥铁律。
