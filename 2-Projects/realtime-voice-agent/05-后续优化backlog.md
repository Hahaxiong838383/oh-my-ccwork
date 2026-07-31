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

### ~~B8 引擎装配前移~~ ✅ 已完成(2026-07-31,330d75ce1)
**立项假设被实测推翻**:引擎构造只要毫秒级(TurnDetector 1.7ms),547ms 不在那里。细粒度打点后真凶有二,都已解决:
- **等 participant 串行阻塞**(9~1570ms 剧烈波动=等用户进房):挪到 session.start 之后,identity 改延迟注入(`_user` 本就 per-request 读)→ 装配与等待重叠,agent 先到场景整段省掉;顺带修了"用户没进房就 greeting"的漏说。
- **模块首次 import**(job 内 _build_llm 首次 320ms/二次 0.2ms):按 provider 预 import 到 idle 进程 → 320→115ms。
- 实测终态(主 worker):`ctx.connect=210 vad=0 sidecar=5 build_llm=116 session_start=299 → total 630ms`。
- 余量:`ctx.connect` 210ms 与 `session_start` 299ms 是框架/网络内部,再压需动 worker↔livekit 直连(明文降级,未做)。

### B9 声纹打断门控 🔶 已上线**观测模式**(2026-07-31,主 worker 独享)
- 形态定稿=**乐观打断+事后否决**(不是"先判再打断"——声纹要 ~1s 音频、打断要 ~100ms,物理不可调和):VAD 一响照常瞬停,并行攒音频跑声纹,判非注册用户则提前恢复播报。
- 真实价值场景=**电视/旁人持续说话**:能出字(字数门拦不住)+人声不断(假打断 timer 被反复重置永不恢复),声纹是唯一解。
- 现状 `BARGE_SPEAKER_GATE_MS=700 act=False`:**只打日志不改行为**。开真动作前必须先看日志——注册与识别若非同信道,score 整体崩(2026-07-03 实测 0.072),此时开动作=主用户插话全被否决,比不做更差。
- 转正条件:日志里川哥自己的轮次稳定 `registered(...)`、电视/他人轮次稳定 `unregistered`,再置 `BARGE_SPEAKER_GATE_ACT=1`。

## 对外协作线(同事 demo,2026-07-31 §十 交付后)

### C1 哨兵挂断实弹联调(等同事开 BRAIN_END_SENTINEL)
- 服务端已 armed,同事侧 6/6 用例已备;约时间一起看日志(剥离是否干净、播完时机是否自然)。

### C2 level 事件(9.3 B 档,约半天)——等同事拍板
- A/C 档已零成本上线,B 的必要性下降;同事说要才做。

### C3 唤醒词放服务侧(9.5,仅评估)
- 前置:常连房间成默认形态。难点=持续音频计费模型(需本地轻量检测+命中才进云端识别)+自定义唤醒词训练。
