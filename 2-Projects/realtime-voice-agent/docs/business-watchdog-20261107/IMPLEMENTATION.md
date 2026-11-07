# 长房间保护实施与验收记录

状态：开发中，未部署。基线 c19e0964；回滚标签 rollback/p003-business-watchdog-pre-20261107。

## 范围与完成条件

沿联合报告实施：独立于循环心跳的业务截止、输入/输出及有界任务进展、启动无帧覆盖、原room SID清理确认、两池回归和单SN灰度。最初无有效输入和12张票的端侧路径仍待证据，不能以关房成功销号。

| 项目 | 当前证据 / 下一门 |
|---|---|
| 源码回滚 | 私有 BASELINE.json；本地tag指向原干净HEAD，发布前需推远端核同 |
| 运行回滚 | 21:18核主池PID3179125、NRestarts0、proc SHA35f59ecd；/root/p003-business-watchdog-20261107/rollback-before含二进制、env、unit及SHA清单。首次SSH断线已记录，重读并幂等备份通过；未停服务 |
| 独立截止模型 | business_watchdog.rs，12项先红后绿；尚未接业务输入，不等于产品修复通过 |
| 配置与范围 | 默认关闭、观察/执行分离、非空SN范围；必须接受信配置，不能信设备自报字段。现役Brain源码未发现session_idle_timeout_ms，需继续核通用配置载荷与管理后台，不凭默认5s推实际配置 |
| 输入与输出 | 已接精确PCM标量诊断、ASR final房间/trace归属；待接关房决策所需PCM/VAD与播放进展，非零帧数不能当语音，长输入无ASR final不能误关 |
| 活动保护 | 回复/搜索/命令/倾听各自代次和绝对截止，同代次重复状态不能延期；倾听只接受新权威租约续期 |
| 启动无输入 | 计时从assignment单调时钟开始；prebuild已移入pipeline Owned任务，不再堵住job事件循环；2项真实异步测试先红后绿，启动截止仍待接线 |
| 关闭确认 | 待精确SID读回和普通池失败可见性；2xx不等于已清理 |
| 回归及灰度 | 待独立固定SHA审查、全套Rust、Linux release、真实RTC合成故障/普通语料、候选池对照、目标SN及安卓定向验收 |

## 当前设计约束

- 心跳不算业务进展；重复ready只允许首次建立输入基线。
- 空闲5–300秒只是候选客户端接受范围，不能把它当该设备已应用的配置。
- 缺失/非法策略只观察，不允许未知配置直接执行关房；上线前必须补齐受信配置与实际语义。
- 有界活动用单调递增代次，终态保留已见代次，迟到start/end不能续命或结束新任务。
- 新票、prefetch不踢旧房；不重放已提交或结果未知的问题。
- 原11月6日生命周期、容量恢复及TTS改动必须保留；两池不同基线分别对齐，不能整树覆盖。

## 测试证据

私有目录 /Users/fu-121/.local/state/p003-business-watchdog-20261107。
policy-red.log：无保护骨架10项均失败，原始失败保留。
独立rustc测试：12项修复后通过。Linux cargo test --offline --locked 最终506/506通过（492原有+14新增），日志worker-prebuild-green.log，构建输入SHA在source-prebuild-green.json；未跑真实RTC或部署。既有llm.chat dead_code警告仍在。
Grok实施前复审task de806b98-cdee-4040-bbfc-a87447ffb87a / 会话162已完成。其新增“未知策略300秒、观察到期自动开删”和_sec配置建议没有直接采纳；主Codex回应后已交会话163定点复核。主Codex亲自写代码。

署名：codex（OpenAI）| 2026-11-07

## 代码检查点（尚不是发布候选）

已改 main.rs（挂模块）、business_watchdog.rs（截止模型与不截断的PCM标量统计）、pipeline.rs（10秒标量与ASR final关联日志）、job.rs（prebuild不阻塞房间循环）。
保护模型目前未消费真实业务活动、未决定生产关房；不能将506个绿灯写成长期留房已修复。部署前仍需策略签票、真实进展接线、受控关闭/精确SID确认、候选池对照与单机闭环。

首次prebuild测试因测试模块缺限定名而编译失败；修正后得505 PASS/1个预期行为FAIL，移入pipeline任务后506 PASS。全部失败记录保留。
