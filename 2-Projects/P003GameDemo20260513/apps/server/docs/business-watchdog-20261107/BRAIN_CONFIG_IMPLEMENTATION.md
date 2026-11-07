# 业务无进展保护：Brain 配置与签票基础

状态：隔离代码测试通过，未部署，尚非完整发布候选。

## 基线与回滚

本树来自2780df3c；源码回滚tag rollback/p003-business-watchdog-brain-pre-20261107。config-store.ts、device-session.ts、device-config.ts与21:20左右只读采集的现役源码逐字一致，SHA在私有BRAIN_BASELINE.json。不得用普通Worker树中旧server整体覆盖生产。

发布前还需重核服务端文件漂移，备份目标源文件、配置有效值与UI文件。回滚逐文件执行；若已显式下发设备新空闲值，回滚不能只省略字段，要记录并恢复期望值。不得整库回灌。

## 已实现

- 单一设备配置键 voice.session_idle_timeout_ms，显式值5000–300000整数毫秒。0仅表示不下发，快照不含该键；未配置设备的原快照保持不变，不把内置5秒强推给所有设备。
- 复用原全局/SN覆盖/tombstone/revision及管理员接口；保留原注册表顺序。UI显示毫秒、0的含义和有效范围。
- Session API从同一有效快照取合法非零值，签进voice_idle.timeout_ms/revision，同时回响应；不读取body自述策略。没有策略时两处都省略。
- 签发自检校验策略与响应一致；未知旧Worker会忽略新增metadata。

设备收到新配置与实际应用到下一会话仍需单机证据，签票不是应用确认。新metadata也不是自动开启Worker回收；Worker执行开关、SN范围及实际业务接线尚待完成。

## 已验与未验

7组定向测试全部exit0：设备配置36项、设备签票45项、配置新用例4项、签票新用例4项、倾听HTTP集成1项、analytics-tier-settings、analytics-auth-config。全部使用隔离临时库/合成凭据，未发真实RTC票给生产、未操作真机。

失败原件保留：新配置初版改变注册表首项导致旧回归1项失败，已移动到坐姿键之后恢复36/36；一轮执行cwd错误导致tsx找不到，已回server目录重跑；Session新用例首次合成SN日期不合法返回400，修正后得到正确的缺metadata/缺自检失败，再修业务后通过。

未验：生产UI渲染、公网签发、全仓typecheck、实际设备配置应用、Worker消费/回收、完整搜索/倾听/方舟真人回归。不能凭这些定向绿灯宣称留房故障收口。

Grok会话163已书面撤回未知策略300秒自动关闭、观察到期自动开删，以及所有搜索统一80秒的建议；最新共同范围见GROK_IMPLEMENTATION_FOLLOWUP.md。

署名：codex（OpenAI）| 2026-11-07
