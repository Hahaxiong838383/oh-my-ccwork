# 后续优化 Backlog

> 归档待立项项。完成后移入 04-决策记录。

## 来自 qwen-audio-agent 源码调研(2026-07-29,Apache-2.0 可借鉴)

### B1 ★★★ 后台任务并行 + 礼仪播报(打包一个专项,~2-3 天)
- **痛点**:长任务(查资料/整理/复杂请求)同步堵死对话——小可"查完讲给我听"、MyJavis"弄好了叫我"均无解。
- **移植形态**:大脑侧任务管理器(参考 `task/task-manager.mjs` 704 行:queued/running/delegated/finalizing 状态机+持久化崩溃恢复+per-user 并发上限)+ worker 侧主动播报(我们 generate_reply 基建现成,GREETING_MODE=llm 同款机制)。
- **礼仪播报**(参考 `voice/announcement/` 491 行):阻塞三条件(用户在说/本轮响应未完/有音频在播)+安静窗定时 flush+批量合并;投递可靠性=租约语义(claim→TTL/3 心跳续约→delivered 确认→失败释放重试)——inplace_not_delivery 教训的工业级解法,Python 翻译直接挂 worker。

### B2 ★★ 委派工具中文 prompt 写法(零成本,下次动 function call 顺手抄)
- 参考 `voice/realtime-provider.mjs:17-60` 三条工具描述:①"先说一句**具体行动预告**,不要'好的收到'类通用承接语"②"accepted 只表示受理,不重复确认不声称完成"③objective="意图交接非历史替代,消解指代但不猜测"④取消工具"不要只口头说忽略结果"。

### B3 ★★ 权限审批进语音流(接 coding agent 时必需)
- task.permission.requested→语音播报征求→resolved 自动取消排队中的重复播报。未来"语音指挥 cc/Codex"场景的前置件。

### B4 ⭐ DashScope Omni Realtime 列为 tier B/C 候选引擎
- 它证明了托管全双工的工程形态;与火山 Seeduplex 对比测,接全双工 L5 路线图。

## 判停/全双工线(2026-07-29 POC 后续)

### ~~B5 interim 文本提交~~ ✅ 已完成(2026-07-29,判停 551→401ms,见 04-决策记录)
### ~~B6 极限档联调~~ ✅ 已完成(阈值 0.18 + END_WINDOW 150 + MIN 0.40 已上线主 worker)

### B7 backchannel(L4,框架有现成挂点)
- 1.6.3 有 _AgentBackchannelOpportunityEvent(暂内部 TODO);filler 机制升级为"说话中语义 backchannel"。

## 性能线(2026-07-31 遥测数据后)

### B8 ★★★ 引擎装配前移到进程预热(入房 1089ms 的一半)
- 实测构成:job 派发→入房 542ms + **引擎装配+session.start 547ms**;后者是 STT/TTS/LLM 客户端与 EOT 模型的每 job 重建。
- 形态:能在 prewarm_fnc(进程级)复用的挪进 proc.userdata(VAD 已是此形态),per-job 只留必须新建的。风险:租户 BYOK 凭据热读语义不能破(每 job 读一次是特性)。

### B9 ★★ 声纹门控替代 0 字门(两阶段打断的终解)
- 现状:MIN_INTERRUPTION_WORDS=0 换来插话瞬停,代价=环境音让 AI 卡壳(安静桌面划算,客厅要回调 1 字门)。
- 形态:P1 声纹旁路已有 sidecar 基建,判"是不是主用户在说"再决定打断,两头好处都要。

## 对外协作线(同事 demo,2026-07-31 §十 交付后)

### C1 哨兵挂断实弹联调(等同事开 BRAIN_END_SENTINEL)
- 服务端已 armed,同事侧 6/6 用例已备;约时间一起看日志(剥离是否干净、播完时机是否自然)。

### C2 level 事件(9.3 B 档,约半天)——等同事拍板
- A/C 档已零成本上线,B 的必要性下降;同事说要才做。

### C3 唤醒词放服务侧(9.5,仅评估)
- 前置:常连房间成默认形态。难点=持续音频计费模型(需本地轻量检测+命中才进云端识别)+自定义唤醒词训练。
