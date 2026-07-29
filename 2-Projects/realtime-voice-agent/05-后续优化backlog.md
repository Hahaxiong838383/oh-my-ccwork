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

### B5 interim 文本提交(破 500ms 判停地板的唯一路)
- 现状:判停地板=火山 definite 到达(~500ms);S1 canonical 基建已铺路(interim 与 final 去标点全等率高)。
- 形态:高置信轮不等 definite,用 canonical interim 文本 commit;错字风险由 canonical 对齐兜底。

### B6 极限档联调(数据后拧)
- POC_EOU_UNLIKELY_THRESHOLD(已有旋钮;2026-07-29 真机数据:川哥对话轮 8/9 概率 0.19-0.35<默认阈值 0.355 走慢路——阈值 0.18 试验中)+VOLC_ASR_END_WINDOW_MS 150(切碎险)。

### B7 backchannel(L4,框架有现成挂点)
- 1.6.3 有 _AgentBackchannelOpportunityEvent(暂内部 TODO);filler 机制升级为"说话中语义 backchannel"。
