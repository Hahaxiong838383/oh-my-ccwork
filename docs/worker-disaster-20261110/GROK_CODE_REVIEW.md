无阻断缺陷。仅静态审阅通过，本轮未重跑测试。

Worker 树 `b071e579`（相对 `f5d6bc5f`）与后台树 `a8226a0d`（相对 `8d38df3d`）均已核对。审阅范围是 `llm.rs`、`pipeline.rs`、`apply_hotwords.py`、`admin-data.ts`、`admin/index.html`。未改代码、未部署、未再委派；本结论不代替你对主 13 的实施与部署授权。

十类检查在当前 diff 中均未形成阻断：

- 父 future 取消：`OwnedChat` 在 `llm.rs:476-478` 的 `Drop` 里 `abort` 已持有的 HTTP 任务；无备用时请求留在父 future 内，不另起脱离任务。
- 控制 token：`llm.rs:480-488` 用 `split_dev_inband` 判断，纯控制 token 或空白不能定胜负；下游 `pipeline.rs:3900` 仍再剥一次。
- 出字后换模：`llm.rs:549-561` 先固定胜者并中止另一路，再向下游送出首段正文。
- 总预算：`llm.rs:513-515` 的截止点从本轮起点计算，备用启动不重置；缺省与发布校验都是 2000/6000（`llm.rs:471-472`，`apply_hotwords.py:444-450`）。
- 开关：`llm.rs:60` 仅 `LLM_FALLBACK_ENABLED=1` 才配置备用；缺省与 `0` 均为关闭。
- 切供应商：`apply_hotwords.py:458-472` 先把旧端点密钥写入各自 profile，再只取目标端点密钥；测试端点不同则拒绝代发（`apply_hotwords.py:732-733`）。
- 并发写：`apply_hotwords.py:783-791` 对 `race_set` / `voice_set` / `apply` 使用非阻塞独占锁，占锁时直接拒绝。
- 回显：`apply_hotwords.py:396-409` 只掩码 `LLM_FALLBACK_API_KEY`；profile 只返回 `key_set`（`384-388`）。管理接口失败回执走同一进程视图。
- 界面与生效：进程行读 `proc`，表单读文件；不一致由 `index.html:2054` 与 `5279-5281` 标出。新文件未写开关时表单为关。
- 发布回滚：`apply_hotwords.py:561-591` 先整文件备份，健康检查失败后按备份字节写回并再拉起。备用预热已去掉（`pipeline.rs:820`）。

你列出的真实 HTTP、Rust、Python、TS 与生产交互结果，这次没有复跑。
