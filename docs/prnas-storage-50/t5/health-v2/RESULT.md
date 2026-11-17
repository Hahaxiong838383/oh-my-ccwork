# T5 工具推进：健康采样有界化

用户2026-11-17恢复主线推进，并授权语音引导分支并行开发。此轮只改T5隔离测试脚本，不改生产源文件、索引、配置或设备数量。

- 将内存health数组限制为256条；原始全量继续写health.jsonl。历史失败次数/状态分布和RSS/WAL峰值、最小剩余空间覆盖全部样本，不因尾部淘汰丢失。缺测保持null。
- 结果schema标evidence_version=2，health只代表尾部，health_summary注明总数/截断及原始路径。旧证据不重写；读取新结果必须看summary及全量JSONL，不能用尾部代替全过程。
- 停止采样后等待当前请求结束再生成结果；证据写入失败使测试失败，不能记作通过。

验证：固定Node24.19.0。storage-load-health.test.ts加速投喂86400条，通过内存256上限、全量JSONL86400行、早期503和峰值不丢、循环顺序、缺测null及磁盘写失败。analytics-load-accounting.test.ts原有丢ACK/重复/精确ID和seen差异测试通过。不是24小时墙钟测试。

实际localhost HTTP+writer+SQLite+checkpoint+Ark+maintenance+backup：2×601=1202事件、8批200、1次503退避，精确对账通过、Ark2/2、dirty0、backup exit0。成功ACK p95/p99约138.39ms。14个健康样本全量保留。证据见SMOKE.json/log；本地Mac结果不替代云端容量。

仍需：client requests/completed及会计Set流式化、正式soak时间调度与缺字段失败判定、CPU/可用内存/重启观测、600k、成熟库、语音、NAS断线与24h实际验收。未启用新云端压测，未进入T6。

## 并行与当前基线

会话360当前HEAD18a23075，工作区干净；CLOSEOUT.md记录5949c07f服务端09:33发布、3fefc6c3和eb8ccaa3静态后台更新。短信登录优先，微信后置；真实手机/新设备包验收仍待。T5运行代码与其analytics/index.ts和admin/index.html有直接重叠，后续从该新线上基线做逐段合并；本轮只动scripts，无这些文件冲突。

语音引导已在独立工作树p003-voice-onboarding-20261117、分支codex/p003-voice-onboarding-20261117、Codeg folder67/session373，由codex gpt-6-astra开发。合同SHA f33522f45fd8d52cdd3c08759e0a894c65d296a1d2e7170ff19b2a827dbce679，回滚基线18a23075。主13负责候选独立验收，子会话无生产写入/开窗授权。

已通过当前HTTP wrapper→store→真实侧栏行投影验证，373出现在folder67，原13仍保留；原生正文有任务与进度。CUA无browser/app，视觉未验，不声称看到了用户屏幕。

署名：codex（OpenAI）｜2026-11-17

10:52独立只读核验：线上analytics/index.ts、miniapp-dashboard.ts、routes/telemetry.ts和admin/index.html四项SHA与360最终18a23075均一致（AFTER360-LIVE.json）。第一次SSH banner超时、第二次成功；未重启任何服务。只证明四项文件一致，不扩大为整个部署树全量独立验收。
