# 倾听池业务空闲回收实施计划

> 执行：Codex亲自实现；沿既有用户授权执行，Grok只读评审。使用 executing-plans。

**目标：** 将主池已验证的业务活动回收移植到当前倾听运行源50bac0b2，避免空房长驻，同时不打断有效倾听与唱歌。
**架构：** 复用 business_watchdog/runtime 的绝对期限模型；倾听仅凭真实接收的租约、session上限和协议转换期限保护。保留候选schema1持久清理及当前搜索/反馈实现，逐文件移植。
**技术：** Rust/Tokio、现有LiveKit、Linux离线构建；不新增依赖。
**设计基线：** 主池 docs/business-watchdog-20261107/P003_JOINT_CONCLUSION_AND_PLAN_20261108.md；当前Listening mode/runtime/adapter实际合同。

## 全局约束
- 基线HEAD22ab1c31；本地回滚标签 rollback/p003-listening-watchdog-pre-20261108 已建立，正式发布前核远端标签。
- 仅03800006既有倾听灰度；其他池、设备范围、窗口、DB均保持。
- 无有效签名voice_idle时只观察；候选沿原schema1登记，失败拒绝job；不靠active/busy或静音续期。
- 本次部署需先完整单测、隔离真实RTC/ASR/TTS、正式产物SHA/ABI、Grok复核与实际线上漂移检查。

## 重点反例
1. 预构建永不返回仍能在启动期限回收；取消同时释放其ASR。
2. 普通静音不能续空闲；真实语音识别建连超过5秒不误关。
3. Listening/唱歌有新租约继续，重复轮询不能续租；lease过期/撤权不继续保房。
4. 进入/退出有界转换及反馈期不被误关，正常聊天恢复不带旧租约。
5. 同房名不同SID/删房失败保留独立回收；不虚称原子CAS。

## 任务与验收
- [x] 任务1：job预构建所有权。先抽出原有等待逻辑，添加卡住预构建测试观察失败；将等待移入受控pipeline任务，取消测试转绿。
- [x] 任务2：移植 business_watchdog.rs/business_runtime.rs；job可信metadata、共用启动期限、原候选清理；pipeline真实输入/PCM/识别及有序输入hold；search_tasks按actor绝对期限快照。仅必要小补丁，不复制整份pipeline。
- [x] 任务3：listening_mode暴露有效lease/session边界；runtime转为anchor绝对Instant；adapter只转发权威lease与Entering截止，proposal/pending不保房；pipeline添加Listening活动保护。覆盖五类反例并保留红测证据。
- [ ] 任务4：离线完整测试，固定候选与产物溯源；真实隔离RTC验证普通静音回收、长讲述、租约失效、退出恢复与延迟ASR。与Grok核对反例。
- [ ] 任务5：备份实际二进制/env/release及Brain manifest；仅空闲时发布单池，核ready/清理健康/正式探针/其他池不变；回执、commit+push。

未完成项不得标部署通过；真人Android验收独立记录。
