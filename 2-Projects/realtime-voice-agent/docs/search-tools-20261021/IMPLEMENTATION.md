# Worker 后台搜索候选记录

状态：候选代码与隔离测试已完成，未替换现役Worker、未更改生产env、未重启服务；真实RTC与单机灰度尚未通过。

- 分支：codex/p003-worker-tool-lifecycle-20261021。
- 基线：491e068a9f5e5e5538dd6188eb202255787dc2bc；现役部署记录4984e0278至此基线的Worker目录无差异。
- 现役SHA256：deea58bf0a594a9a86a0d422fec2e36289b1f7c97b3c4857aa0e313ba5d9163d。
- 现役MD5：80475d393128efc56c60908e92f9478a；hk2 d21部署记录与Air 2026-09-23记录相互匹配，但不等于可重现构建证明。
- R0：/root/rust-worker/backups/search-tools-20261021-before/worker-before.tar.gz。
- R0 SHA256：570128844cdd391fc0efef98e7785348d7d564c16794d7abe44c517996190af7；含现役产物及私有配置，归档不入Git。
- 新增src/search_policy.rs、src/search_tasks.rs；main仅注册模块；pipeline新增独立背景播报类型，不写普通对话历史，不await搜索HTTP。
- 默认P003_SEARCH_ENABLED未设=关闭，P003_SEARCH_DEVICE_ALLOWLIST为空=关闭；只有明确搜索命令且房间SN在名单时接单。
- 基线343测试，候选352测试通过；Ubuntu24.04发布构建通过，GLIBC最高2.39，GLIBCXX最高3.4.31；仅构建目录有新产物。
- 本轮音频/字幕/metrics三通道、真人pause/假打断、极早打断续讲准确度、断网时撤销与单机长稳尚未验证，不能上生产。

完整双端设计、协议、真实官方API冒烟、前端截图与发布门位于另一分支codex/p003-brain-search-tools-20261021的`2-Projects/P003GameDemo20260513/docs/search-tools-20261021/`。共享合同为仓库`4-Assets/contracts/p003-search-task-v1.json`。

回滚先热关大脑p003.search.enabled；若须回退Worker，重新取R1并核活跃job=0，stop→sidecar清零→校验归档并恢复二进制→start；3分钟复核注册与重启数。禁止直接拿本分支全仓覆盖另一条大脑生产线。

署名：codex（OpenAI）| 2026-10-21 北京时间
