# P003 v398 服务端候选交付

开发与本地自检候选；没有宣布生产或真机通过。主13须读取源码、复跑证据并独立裁决，不能只凭本回执通过。

## 候选与来源

- 工作树：`/Users/fu-121/.codex/worktrees/p003-voice-onboarding-20261117`。
- 固定分支：`codex/p003-voice-onboarding-20261117`。候选是包含本交付文件的最终commit；完整SHA及push远端核同结果见当前真实会话最终正文。
- Brain基础：`18a230754941ad9781db4d39e5a12a9622fc7349`；合同提交：`4ae598cd0c04c6d22467063fa48e0d70ab055459`。
- 冻结附件SHA256：`f33522f45fd8d52cdd3c08759e0a894c65d296a1d2e7170ff19b2a827dbce679`。
- Rust基础：`262dfe9c0a7bc9c44769670e0312bcb66cb32671`，从此前ASR修复分支发布manifest定位；现役普通池二进制只读核验与manifest的`d37a39633ed8e7766e35744baf0b78ca2fbc12777a91b9a89f166029748c1c69`一致。不是360树里的旧Python。
- 导入99个Rust基础文件，95个保持逐字节一致；改动control/job/main/pipeline四文件，新增独立教学模块、测试与轻量入口测试crate。详见`SOURCE-PROVENANCE.json`。
- Brain的index/device-session/profile/registry部署源码在只读核验时与18a23075一致，见`BRAIN-SOURCE-CHECK.json`。主13合入T5前必须再次做差分；本候选未覆盖analytics或admin页面。

实现固定提交：`1cf9428e19ce482e6b9958821837c9a845e2572f`。后续交付文档提交不改变实现源码。

## 最小实现与数据归属

Brain新增`voice-onboarding-store/runtime`和内部路由。真实绑定registry解析唯一Brain孩子；父档案已知字段跳过，绑定/档案全快照参与事务比较。按age→gender→nickname的实际缺失选题，拒绝/模糊不写。年龄保存`age_years`与`age_observed_at`，不造生日；现有普通聊天prompt读取观察年龄。

devices数据库增加`voice_onboarding_session/receipt`；profile数据库增加两列。所有保存都在同步事务内重新核绑定和revision，COMMIT返回后才生成saved响应；回执仅摘要，不包含孩子答案。request_id异内容冲突，不重复提交；同SN任何新会话撤销旧授权。已有事务记录尚未做自动保留期清理，后续按运维策略清理过期记录，不删孩子资料。

Rust的`voice_onboarding.rs`拥有单课状态、动作幂等、revision、唯一音频token、固定180秒、异步HTTP与输入门禁。生产入口是`control::parse`→`job`当前participant校验→`pipeline.on_control`→Runtime；不创建新房间，不启新TTS。收到当前audio_complete才进入收答；waiting_exit继续说话转normal_chat，沿原普通生成和退出逻辑。

## 启用条件（仅说明，本次没有设置）

必须同时满足客户端supports、普通pool、非倾听、显式SN名单和准确agent名称：

|配置|用途|
|---|---|
|`VOICE_ONBOARDING_ENABLED=1`|可选能力总开关，默认关闭|
|`VOICE_ONBOARDING_SN_ALLOW`|既有可信云SN的显式逗号名单，不使用USB编号|
|`VOICE_ONBOARDING_WORKER_AGENT`|已安装本候选的普通worker agent准确名称|
|`VOICE_ONBOARDING_WORKER_ACCOUNTS`|内部接口允许的既有Worker JWT accountId，默认worker-service|

内部`POST /v1/internal/voice-onboarding/step`验证既有Worker JWT（issuer/audience/role/account）及session专用grant。RTC metadata可被端侧解码，grant本身不能授权写资料。Worker复用现有LLM_URL_QUERY中的token，作为HTTP header发送；不得记录或回传原文。发布前须核实际服务账号与此配置匹配。

## 本地复核入口

|检查|实际结果|
|---|---|
|Brain新增（含实际HTTP/SQLite）|20/20|
|Worker控制入口（含跨进程HTTP/SQLite）|38/38|
|原session / extractor / exit / memory回归|45 / 25 / 58 / 15 全通过|
|Rust整包编译、macOS候选链接|通过；候选未执行、未部署|
|Rust全量测试|626通过、4失败、2忽略；四失败在262dfe9c原基线复现，依赖Linux /proc及127.0.0.2语义|
|TypeScript全量检查|一个既有GeminiLlmClient.abort错误，18a23075同依赖复现；未新增错误|

详见`TEST-RESULTS.json`及`evidence/`文本日志。所有HTTP/SQLite测试使用随机临时库、合成身份和本机临时端口，没有加载生产.env或调用src/index.ts。

```sh
# 工作树根目录；使用已有符合项目要求的Node22、npm依赖与Rust工具链。
cd 2-Projects/P003GameDemo20260513/apps/server
node --experimental-sqlite --import tsx --test scripts/voice-onboarding.test.ts scripts/voice-onboarding-memory.test.ts scripts/voice-onboarding-session.test.ts
node --experimental-sqlite --import tsx scripts/device-session.test.ts
node --experimental-sqlite --import tsx scripts/onboarding-extractor.test.ts
node --experimental-sqlite --import tsx scripts/exit-intent.test.ts
node --experimental-sqlite --import tsx scripts/memory-extract.test.ts
# 回到工作树根目录
cd ../../../..
cargo test --locked --manifest-path 2-Projects/realtime-voice-agent/rust-worker/tools/onboarding-entry-tests/Cargo.toml
cargo test --locked --manifest-path 2-Projects/realtime-voice-agent/rust-worker/Cargo.toml --bin voice-rust-worker
```

本次依赖和工具链隔离在当前树`.voice-onboarding-test-deps`、`.voice-onboarding-build`；最终Brain复测采用原package-lock执行npm ci的隔离依赖，未提交，未修改全局版本。轻量crate直接include生产control和教学实现，只替代无关canary指标结构，不含RTC SDK；完整Rust测试另行记录，二者都不能代替真实RTC。

macOS应用构建须沿基础`.cargo/config.toml`的`-ObjC`链接要求；Linux发布须在主13批准的对应目标环境从固定候选构建，不能上传本机产物。不要直接使用整树覆盖其他pool或T5。

做基线对照时须给基线单独的`CARGO_TARGET_DIR`，防止同名crate测试产物互相覆盖。本次收尾曾发现这一缓存问题，最终强制重编译当前候选，并核全量中确实有14个教学测试；不能仅看cargo退出码或可执行文件名。

## 主13尚须独立验收

1. 读取`CONTRACT-GAPS.md`中的9秒丢包、回声退出短词、取消提交顺序、跨库崩溃边界；若要改Android合同先记差异，不私自加协议。
2. 从固定候选复核Brain增量及Rust现役来源，构建Linux普通池产物，核供应商/Worker真实鉴权兼容性。
3. 在另行授权的单机窗口核当前worker SID/trace/session、7cue实际播放回执、无重复TTS、ASR回声隔离与自然答题。
4. 同轮对账全知/部分/全缺、拒绝/静默/失败、重复与旧包、180秒、9秒放行、倾听互斥、首句不吞、继续聊保房、任意阶段退出及真实提交。
5. 本次未部署；回滚点和后续发布回退范围见`ROLLBACK.md`。

实现及自检由本会话codex亲自完成，未委派；阶段进展保留在当前真实会话正文。
