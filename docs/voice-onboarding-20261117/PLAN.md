# P003 v398 实施计划

目标：同一普通房间内，按可信绑定孩子的缺失资料，完成一次有界语音教学；真实事务提交后才能 saved。
执行：本会话 codex 亲自实现；主13独立最终验收。不委派、不部署、不重启、不改真实资料。
合同：TASK.md / CLIENT-CONTRACT-v398.md，附件 SHA256 f33522f45fd8d52cdd3c08759e0a894c65d296a1d2e7170ff19b2a827dbce679。

## 基线与结构
- Brain：18a230754941ad9781db4d39e5a12a9622fc7349；当前合同提交4ae598cd。
- Rust：普通池已发布262dfe9c0a7bc9c44769670e0312bcb66cb32671。只导入 rust-worker 及编译必须的共享fixture，不合并整树。
- 新增 Brain voice-onboarding-store/runtime/route：短授权、可信目标解析、SQLite事务CAS、年龄年数与观察时间存储，禁止伪造生日。
- 新增 Rust voice_onboarding 模块：控制入口、请求幂等、revision、音频token、180秒固定期限、异步Brain请求；pipeline/job/control 最小接线。
- 普通未协商房间的语音处理旁路；只在显式名单和准确worker agent匹配时签发能力，默认关闭。新会话同时撤销旧课授权。

## 执行步骤
- [x] 完整读合同、核SHA、核现役普通池二进制与发布记录。
- [x] Brain：先写实际HTTP+SQLite失败用例，再实现条件读写；覆盖全知/部分/全缺、绑定变化、同ID异内容、已知不覆写、落库失败。
- [x] Worker：先写控制处理入口失败用例，再实现状态机和pipeline；覆盖音频回执、拒绝/模糊、重放/乱序、硬期限、保房/退出、普通旁路。
- [x] 本树编译、自检、回归；源码来源及生产差异记录；真实RTC/Android/供应商边界单列。
- [x] SERVER_HANDOFF.md、TEST-RESULTS.json、ROLLBACK.md及证据已生成；实现源码已固定commit。
- 最终交付commit/push与远端SHA核同记录写入本会话最终正文，避免计划文件自引用自己的commit。

## 验证重点
1. 保存与绑定检查必须在同一SQLite写事务；所有当前目标资料参与快照比较，跨进程换绑不能漏。
2. 每个动作幂等，旧动作不倒退状态；同ID改正文拒绝；保存结果须事务返回后发送。
3. 播音时不接答案、不投机生成、不远端重复TTS；audio_complete失败不能进入收答。
4. 180秒不续期；端侧9秒无响应释放不等价于服务端保存成功；撤销先提交时迟到答案不能落库（不撤销已先提交的真实资料）。
5. 普通首句与现役ASR/ready/退出不回归；倾听池不替换，未签能力不可开始教学。

## 实现后自审修正
- RTC metadata可被端解码，因此grant之外强制验证Worker JWT，不能让客户端直写资料。
- 任何新session撤旧课；begin等待原首轮期间的cancel/finish会阻止迟到开课。
- 普通字段补充保留已知年龄，复制另一孩子档案重置旧观察值。
- 全量Rust四个macOS失败已在262dfe9c原基线复现；TypeScript唯一错误也在18a23075复现，详见测试记录。
