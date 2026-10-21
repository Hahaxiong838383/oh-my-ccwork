# 指定 SN 搜索候选 Worker 运维记录

**2026-10-21：独立候选已部署，正式设备窗口未开；当前搜索env=0、window.enabled=false、截止=0，待真机验收。**

目标仅 `BJP00326070803800006`。本轮亲写、不委派，沿用 `codex/p003-worker-tool-lifecycle-20261021`；执行前66b89ac2a7520ac43c58961a8de0426da2633679，功能提交d6c05051。没有合main、没有替换现役Worker。

## 产物与恢复点

- Linux独立构建：Ubuntu24.04/Rust1.98.0；354/354测试，release/ABI门禁通过。最高GLIBC2.39、GLIBCXX3.4.31；3个既有unused警告。43个源码/构建输入与构建机逐文件核同。
- 最终二进制SHA256：`435caa275f1504a6c8c4b583acd670ed3ad28068b615dc3f24d6e96b3a3205ae`，72980816 bytes。
- 现役SHA：`deea58bf0a594a9a86a0d422fec2e36289b1f7c97b3c4857aa0e313ba5d9163d`，PID839/NRestarts0未变。
- R1：`/root/rust-worker/backups/search-canary-R1-20261021T095400Z/worker-R1.tar.gz`，SHA256 `2257d09ffc38d7fa7df5885344b6c788493e78472de19a76a00099869452c174`；实际取证09:53:29.262 UTC。私有配置不出服务器。
- 候选：`/opt/p003-search-canary-20261021`，systemd `p003-search-worker`；agent固定`p003-search-canary-20261021`、max_jobs=1。
- HK2真值本轮核实为64.90.13.177；旧文档.117已过时，遇主机密钥不匹配不要绕过StrictHostKeyChecking。

## 隔离与启停

只访问HTTPS `https://kidshub-ai.hahaxiong.cc/_canary/search-20261021/v1`，精确路径/域/端口、无URL凭据、禁止重定向。普通聊天、本地文本和搜索同走候选；独立密钥/服务账号只放私有env。完全移除LLM_FALLBACK_*，不是设为空字符串。

EOT socket固定`/run/p003-search-canary/eot.sock`，独立sidecar脚本/VAD副本。读取既有模型资产，systemd仅候选根和run可写；EOT snapshot/原始录音capture关闭。MemoryHigh1100M/Max1400M、CPUQuota150%、Tasks128。配置模板在`ops/search-canary/`。

更新顺序必须串行：

1. 产物传至`.new`，**等上传命令成功退出**，核字节数及SHA等于已测试构建清单。
2. 关闭window与Brain热闸，确认该候选jobs=0；记录当前候选产物与配置。
3. stop该候选服务，确认其cgroup/sidecar清空。只对该unit操作，不宽泛pkill、不碰现役unit。
4. 原子替换已核产物，start；核SHA、注册、心跳、错误及三通道，3分钟复核稳定。

本轮曾发生上传未退出就提前安装的错误；因SHA不等立即停候选，完整传输核SHA后才重新启动。事件期间window关闭、无job，现役未动。不能靠当前NRestarts0否认该失败尝试。

## 窗口与退出

`window.json`：enabled、完整sn、expires_at_ms、generation；Brain截止、生产签发截止和Worker必须一致，最长2小时。availability和job入口验证签发metadata中的SN/截止/generation，不信客户端body覆盖。Worker每秒复核窗口，关闭/过期即abort当前pipeline、关房；不在音频帧循环做文件IO。

每5秒上报注册/容量；独立Brain续15秒租约，满载不派新会话。截止不因重启刷新。新会话回现役，已有会话须退出/重连；不是热迁移。

到期实测：2026-10-21北京时间18:16:11.050截止，18:16:11.434触发关房、18:16:11.848完成删除；合成客户端disconnected=true，jobs归零。只验证合成短窗口，未开放正式2小时窗口。

## 验证边界

- 合成RTC普通对话三通道通过；搜索过程中接收4段输入，但不计作3轮完整前台回答通过。
- 最终二进制一次P1空闲补播：账本completed，客户端音频7.74s/用户final1/agent final2/metrics3。日志分清scheduled、实际首音频published和finished，并关联task/delivery/room/turn/session_ms；这些不是设备扬声器实听。
- 一次打断capture_frame冲突21ms重试成功；另一次探针未等ready导致首句丢失，已修正探针，失败保留。
- 停候选Worker/sidecar+Brain后生产health200、生产无凭据session401；候选502符合停机，恢复时全闸关闭。
- 当前APK现场版本、同机30/30/30基线、ordered首句/本地回复语/设备指令、真人pause/续讲/取消/改查、P1质量和2小时长稳尚未完成。P2未开。

先完成现场前置，再创建新2小时窗口，最后开生产单SN派单；立即发实际起止回执。P1真机通过后才开P2，不自动扩面/24小时。总账与设备回执位于Brain分支`2-Projects/P003GameDemo20260513/docs/search-tools-20261021/CANARY_ACCEPTANCE_20261021.md`及同目录`P003_SEARCH_CANARY_DEVICE_TEST_RECEIPT_20261021.md`。

署名：codex（OpenAI）| 2026-10-21 北京时间

## R3：用户明确授权的明日全天窗口

2026-10-21 20:27:30 CST已开启03800006 P1，固定截止2026-10-22 23:59 CST，P2关闭，待真机验收。用户确认现场v353/1.2.2-canary.339，并将普通聊天对照改为其他设备；原同机30轮先行与首轮两小时限制不再作为本次体验前置。

Worker提交3a86e0b7；三侧最长36小时，真实截止不滚动延长。Linux355测试及release/ABI门禁通过，43输入核同。新二进制SHA1875dbf2abc979ebeec7f41830dd6e7c677cf305ea8348aeb34a8524e6ed4f08，72980816B；候选PID715225/重启0，现役PID839/产物不变。低速SSH传输未完成文件未安装；差分恢复后断言完整新SHA与已测产物一致才切版。

R3备份/root/rust-worker/backups/search-canary-R3-20261021T122000Z/worker-R3.tar.gz，SHA104fc00d5a33d20bef7b01610333eb5ecd457c806848ff306fb3d682485f34e3。两端持久timer p003-search-expire-20261022.timer固定到期清配置；Worker每秒独立核截止关房。短窗20:24:40截止，20:24:40.522触发、20:24:41.052删房，合成客户端已断开。P1真实任务completed、合成客户端音频10.12s/字幕/metrics通过，不等于设备实际听到；真人插话/续讲/并行聊天等仍待验。

先热关三侧再回滚，已有候选会话结束后设备重进回现役；不能只关新派单。详细回执、17项用例和R3技术总账在Brain分支docs/search-tools-20261021。
