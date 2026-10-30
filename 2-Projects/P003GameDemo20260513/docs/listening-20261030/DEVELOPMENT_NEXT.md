# 倾听开发接续

现有会话：[Brain38](codeg://session/38)、[Worker39](codeg://session/39)，沿用原分支，不新开同用途工作树。当前语音优先批次与恢复点见 [VOICE_ENTRY_RECEIPT.md](VOICE_ENTRY_RECEIPT.md)，前批归档见 [NEXT_BATCH_RECEIPT.md](NEXT_BATCH_RECEIPT.md)。

- 09:50:48为管理后端，10:17:32为已验收静态标签页；运行链路已编码和隔离验证，尚未部署/开闸。Brain已合入现役标签代码，不能覆盖回旧布局。
- 本批38已交付能力协商/独立voice_command权限、原管理开关一致性及安卓清单；39负责首句STT、模式提议、过渡音频/缓冲与实测。以`contract-ready.json`版本/SHA同步合同，38不改Worker树。历史双方HTTP1项不等于语音通过；R26仍留会话24，不捆绑搜索整合或全量发布。
- 最小联调入口：在 Brain `apps/server` 执行 `node scripts/listening-joint-prepare.mjs <Worker树> <输出bundle.mjs>`，校验合同并复用39既有harness/manifest；把bundle和manifest交给隔离Linux Worker副本，执行原 `scripts/listening/run-joint.sh`。准备不等于运行通过，dirty/未知状态保留。
- 39本批完成后以新commit、首句/语音管线测试及联合日志对齐；真实Android/RTC、普通聊天体验和回滚按实际证据逐步补，不自动部署或重启服务。

原分工见[两分支执行安排](../../../../docs/superpowers/plans/2026-10-30-p003-listening-next.md)，历史管理发布见[ADMIN_RELEASE_20261030.md](ADMIN_RELEASE_20261030.md)。

署名：codex（OpenAI）| 2026-10-30
