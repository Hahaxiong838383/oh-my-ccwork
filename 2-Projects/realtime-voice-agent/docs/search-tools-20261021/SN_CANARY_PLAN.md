# Worker 指定 SN 灰度开发入口

状态：规划已落盘；尚未部署候选进程、开启单机灰度或执行真机验收。

## 分支与历史记录

继续使用 `codex/p003-worker-tool-lifecycle-20261021`，工作树 `/Users/fu-121/.codex/worktrees/p003-worker-tool-lifecycle-20261021`。规划前冻结点 `928dd9fdfee3de4a90130e9d6a64bffe4e8c8f1f`；不新建第三条分支，不改主仓工作目录。

Codeg 文件夹 22 下的 [P003 搜索 Worker / SN 灰度｜历史快照](codeg://session/25) 已导入原 [会话13](codeg://session/13) 截止本次操作前最后完成轮次的历史，回读2152条展示记录。Brain 对应 [会话24](codeg://session/24)。副本与原会话后续消息不自动同步；不同时在多个入口修改同一范围。

## 完整规划与职责

- [本机完整规划](/Users/fu-121/.codex/worktrees/p003-brain-search-tools-20261021/docs/superpowers/plans/2026-10-21-p003-sn-search-canary.md)
- [代码仓完整规划](https://github.com/Hahaxiong838383/oh-my-ccwork/blob/codex/p003-brain-search-tools-20261021/docs/superpowers/plans/2026-10-21-p003-sn-search-canary.md)
- Brain 分支承担 SN 签发策略、隔离数据目录、HTTPS 前缀与总验收台账；本分支承担独立候选 Worker、路径回归、播放/取消证据、Linux构建与服务运行手册。

拟使用完整 SN `BJP00326070803800006`，开窗前重新确认身份与 APK 版本。候选独立 `AGENT_NAME=p003-search-canary-20261021`、`WORKER_MAX_JOBS=1`，只放此设备。保持固定 HTTPS 主域名与443，不放宽搜索URL校验；候选同域路径由 Brain 独立反代接入。

先关搜索回归，再 P1 Search，之后 P2 Tool Calls＋受控 Fetch；真实设备验证普通聊天不阻塞、空闲补播、音频字幕、插话续讲、取消替换、退出与断线。初次2小时，至少20次会话/100轮语音/20次搜索；通过后单机24小时观察。具体量化门槛和失败归类见完整规划，现有单测/API200不代表真机通过。

本阶段拟核查/修改 `rust-worker/src/config.rs`、`llm.rs`、`search_tasks.rs`、`search_policy.rs`、`pipeline.rs`，新增 `CANARY_RUNBOOK.md` 和独立服务模板。所有代码由codex亲写；修改后重新 cargo test 和 Linux release 构建，保存新源码/产物SHA，不能沿用旧产物标签。

共享生产签发层需最小补丁，不能只起测试 Worker 就宣称完成隔离。先核R1，再部署候选，测试后开单机路由；回滚先关新派单与搜索，目标退出重连到原agent后停止候选。生产目录、人格库、音频发布目录、Analytics开关保持隔离，候选数据不回灌。

署名：codex（OpenAI）| 2026-10-21 北京时间
