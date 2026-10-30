# P003 倾听 P0：Worker 发布准备与隔离 RTC 回执

**结果：本轮代码、Linux 发布候选及分层软件 RTC 验证已完成，可交主会话独立验收；真实 Android/真人唱歌尚未验收。**

本轮仅交付候选和实测证据；未部署、未开线上倾听总闸，未修改设备范围、搜索窗口、Android 或另一工作树。真实 Android 和真人唱歌仍待端侧验收。最终测试结果见下方证据，不能用旧批次补绿。

## 版本与现役边界

- 工作树：`/Users/fu-121/.codex/worktrees/p003-listening-worker-20261030`；分支：`codex/p003-listening-worker-20261030`。
- 本轮代码回退点：`8faef1ea8024ea08f9dd15011c572c9e7455e7a6`。保留此前 `9156bf94` 的 pipeline 完成/错误/panic 统一有界收尾。
- 候选运行源码：`b7c94220`（完整 SHA 见构建输入清单；运行修复提交 `d9acb68b`，后续 b7 只补边界测试）。后续证据文档提交不改变这份构建输入。
- 普通现役：`voice-worker-rust.service`，PID `1546073`，启动于 `2026-10-29 14:20:03 UTC`；运行 `/root/rust-worker/voice-rust-worker`，SHA256 `a00744bfb55478e9d549d19f8712e643e2d9234901aa81e3cb93855c4b5ceb2d`。发布记录的源码 `8a34369413035470a929418f1dcd48f1f9ebed57` 与产物摘要对应。
- 搜索现役：`p003-search-worker.service`，PID `1652015`，启动于 `2026-10-30 06:12:19 UTC`；运行 `/opt/p003-search-canary-20261021/voice-rust-worker`，SHA256 `82a55342af43d0c35bb4b624ff2366394d6cf28aeb81f659233616f4ff11136b`。旧 `style-ark-release.json` 的 `c2ef3ca9` / `680af65e…` 已与实际运行文件不符，不能据它断言现役搜索源码归属。
- 搜索验证服务 inactive；本轮未启动。搜索窗口文件 SHA256 `ca222d61d796576b1fdeb73d2d2e180e704c4b369e6262bc07c4cdc28ccb1331`，到期 `2026-11-02 11:19 CST`。未输出名单或凭据。
- 本候选保留普通 R18 + style/ark 基础，**不能整份覆盖搜索 R26**。搜索线后续须从会话24稳定的实际基线最小合入并另验。

## 实际修改及缺陷证据

1. `scripts/build-local.sh` 显式要求 40 位编译 SHA，从 Cargo `compiler-artifact` 取实际 executable；避免另设 `CARGO_TARGET_DIR` 后检查旧文件。脚本测试实际 RED2 → GREEN3。
2. `Cargo.toml` / `src/listening_http.rs` 增加默认关闭的 `listening-rtc-test` 编译特性。测试版仅允许 literal loopback HTTP 和精确 listening 路径，拒绝生产地址及其他主机、userinfo、query、fragment；正式版保留原 HTTPS 完整地址限制、禁止重定向。Client/Service 共用判断；没有运行时绕过或新生产调试入口。
3. `src/worker.rs`：真实 RTC 发现 `max_jobs=1` 时，旧任务结束后 SFU 仍收到旧 Full，下一房可能根本不派单。原先仅 30 秒心跳刷新容量。现任务开始/结束用 Notify 唤醒原 WS 循环，发送时读取最新计数并即时发布 UpdateWorker；保留心跳和容量准入。共享真实发送路径的两项新测试先红后绿。已撤回加槽位绕法。
4. `src/pipeline.rs` 仅补 SpeechStart/abort 的 trace、turn、单调相对时间元数据，便于与客户端同轮核对；不改撤权和逐帧输出语义。
5. `src/job.rs`：第一次新 RTC normal 的全部交互通道通过，但 DeleteRoom 单次请求超时，探针仅清理自己房并明确判失败。同版精准重测 normal 成功，底层网络原因未定，不能宣称已修网络。为倾听元数据房间增加两次各 2 秒、间隔 250ms 的瞬时失败重试，总预算 4.25 秒，低于旧单次 5 秒；401/403/重定向不重试。普通非倾听及搜索原策略保留。实际 HTTP RED1 → job 层 GREEN14；覆盖失联 peer、瞬断、503、持续失败和时间上界。
6. `scripts/listening/rtc-probe.py` / 测试：真实签票、AGENT 身份校验、Android 单一 seq、State 在途、重复命令、双确认、持续合成上行、四通道订阅与精确 Room API 清理。旧 State ACK 不算新 enter/exit 完成；barge 加有界停止和无打断对照。SDK 首轮 lease 场景功能完成后退出 rc=-6，未当通过；补 AudioStream/AudioSource 显式关闭，资源取消 mutation RED1 → GREEN3。

7. `src/pipeline.rs`：e0 统一矩阵新增真实失败：RTC signal 重试令建房耗时 10.183s，旧 ASR 已空等 10.207s，供应商返回 `45000081 / waiting next packet timeout`，首句 ordered 失败；那一轮没有执行租约注入，不能算租约测试通过。按主会话复审补最小失效重建：接管前空等 ≥5s、任务/通道已关闭或已有预输入事件时，先 abort 并有界等待旧任务退出，再使用同供应商新连接；健康新预连继续复用。该检查位于共用 run_pipeline，未来使用本候选的普通/搜索会话在过期时也换新连接；当前 R26 进程仍是原产物，路由/闸/配置未改。旧 Interrupted 不跨连接污染新首句，无模型/框架/协议/等待超时扩大。三项真实失败回归 RED3 → GREEN3；另将年龄门 `<5s` 反向改为 `≤5s`，纯健康空队列的5.000秒边界实际 RED1（其余2绿），4.999秒复用亦有断言；最后版本的延迟接管 RTC 证据另列。对任意供应商故障的通用恢复不在本修复承诺内。

## 隔离运行与真实/替身边界

- 唯一测试 agent `p003-listening-p0-session39`，合成 SN `BJP00326103099999938`；隔离根目录 `/opt/p003-listening-p0-20261030-session39`。独立进程、独立数据库和签票路由，无生产设备 dispatch 或长期记忆写入。
- Brain 实现输入核对到已提交 `365dd76c8c62bec30b04a7cc87638626e4906f4e`，65 项输入逐个核 SHA；RTC bundle SHA256 `05752431e4cb9fcdca06021ee4654525434f6e2cf7ed9d1ae26e6b6e03d776f5`。
- Brain 使用真实 authority、Date.now、注册/config ACK、设备会话及租约路由，Worker 实际先收到 ready=false，应用配置后再 ready=true；没有预种 ready。服务仅监听 `127.0.0.1:18738`。
- RTC 使用同源 `listening-rtc-test` 编译特性的 debug/strip 二进制，只有 HTTP 允许地址与正式版不同；正式候选为默认特性 release，单列 SHA 和兼容检查。未拿测试版代替正式版上线，也不把本轮时延当正式 release 性能基准。
- 真实部分：共享 LiveKit SFU、候选 Worker job→Orchestrator、Silero VAD、火山 ASR、讯飞 TTS、网络音频/字幕/metrics/control、房间 API。
- 替身部分：账号/设备、Android 自动控制及本地空播放队列、合成 WAV、确定性文本模型；合成反馈用于观察待播尾部，不是反馈质量验收。EOT 独立 socket 无 sidecar，实际降级现有 min-delay，不能称完整语义端点验证。衔接音使用隔离合成音资产：环境请求概率1，但实际 `filler_policy_applied` 被 Brain 风格策略覆写为0.25；本轮只证明该有效配置下的倾听静默，未做概率1强制衔接正对照；抑制门另由 Rust 回归覆盖。不是生产音色验收。
- optional ordered `local_receipt` 旁路实际日志为 disabled（metadata 虽支持），本轮未验该独立功能；Android 倾听 `listening.local_ready` 双确认实际执行，二者不能混称。
- disconnect 场景是 SDK 主动断开；lease_timeout 是仅 SIGSTOP 本测试 Brain；revoke 是只改隔离数据库且恢复 revision。没有注入物理断网或改全机网络。
- 所有样本均合成。证据只带标识、摘要及合成内容，不带 Bearer、供应商凭据、现役 .env 值或用户资料。

## 最终结果

- 最后源码/测试提交：`b7c942201d45a6fe92a26488448f4dfb0c1db4b0`（运行修复 d9；b7 仅测试）。83 项输入逐个核 Git blob 与远端，清单 SHA256 `f3f8d7459e178f4d35fd7c34bcff082b09a2e48327608c1e4e34092ab4f351ee`。
- 最终 Linux `cargo test --offline --locked`：503 Worker +29 core +9 runtime +4 parser = **545通过、0失败**；默认忽略2项 HTTP，另以真实当前 Brain bundle 显式 joint **2通过**；测试特性 transport **2通过**。RC 均0。主会话已独立复跑同83输入的545+HTTP2，不能把旧536/538/540/542当最后本轮结果。
- HTTP joint 用 Brain已提交 `2496ac43` 的33输入 bundle，SHA256 `f8c0b92ec702c2c8eee414c81b266794d8d527d84503f6a51ec4833270ff9889`。RTC使用前述已提交365的65输入独立入口。二者均逐输入核对，不读38未完成改动。
- 正式 release（默认特性）SHA256 `830823de3acf43f4692dc19d4e436e6c881a05349bcc78a4f945f19f2570d873`；实际 RTC 测试版 SHA256 `d74855a8110fa2623942255ab7d07d8a4c2e0fb13dc40870280118e866b38929`。各自绑定 b7 编译 SHA，文件及运行中 exe 摘要另核。候选均只存隔离目录，未替换现役。
- 分层 RTC：e0 的 fresh统一7场景 `rtc-run-1793353699185182498` **6通过/1失败**。normal、barge、missing_ready、proposal_timeout、disconnect、revoke均RC0且自动Room API缺房；lease场景在注入前遇到上述ASR旧预连失效。原失败完整保留。同版e0随后lease精准补测RC0，不能擦掉统一矩阵失败。
- 最后 b7 的 11秒延迟发布麦克风定向回归 `rtc-run-1793354897591398945`：**normal / lease_timeout 均 RC0、passed=true**，max_jobs=1；两房 ASR 接管年龄分别10968ms/10919ms，均在首PCM前实际替换旧连接，覆盖原10207ms故障条件。normal 验首句双确认、立即续讲末尾“紫色风筝”进入一次反馈、普通叙述静默、在途State/重复控制、退出恢复普通聊天四通道；lease 实际停隔离Brain、客户端断开、无音频，均自动Room API查无房。不是 b7 全7项重跑。

| 最终 b7 定向 | room | session | trace |
|---|---|---|---|
| normal | sn-BJP00326103099999938-1793354899 | 32c06040-d2d0-4ab8-abe1-552863e1a2a3 | p0-39-d97710cb-1d1d-49d0-88a9-3e0b812265af |
| lease_timeout | sn-BJP00326103099999938-1793354957 | b0dda4e3-c5d9-45c7-b8c6-711dbb4de298 | p0-39-5eff48f8-3aba-48af-a7fe-927be0df98b6 |

- e0 严格插话证据：同52字反馈的无打断对照实际播放9969ms；插话轮实际播放1.328s，provider尚未finished且发送缓冲203ms。上行插话首帧至客户端最后非零PCM为1167.40ms；Worker真实SpeechStart至最后非零PCM约6.05ms，随后3s及退出后无旧尾巴续播。该数据属于e0测试版，不推算release性能。
- 容量实证：max_jobs=1，Full于09:48:54.708 UTC，任务收尾/Available于09:49:04.822，下一房09:49:07.282接受；未等下一次09:49:24心跳，也未增加槽位。
- 收尾：从本轮隔离目录证据提取26个严格合成SN房名，精确Room API查询在停止测试进程前后均0残留；未列出/删除其他房间。自己的Worker、日志收集器、Brain均停止，18738端口关闭，PID文件清除。候选文件和隔离证据保留供复核。
- 生产二次只读核对与主会话独立 `root-production-final.json` 逐字段一致：三服务状态/PID/exe、unit/drop-in/全部环境文件摘要及搜索window不变。没有服务重启、现役文件替换或路由修改。

三合同保持安卓已发修订3的字节：

| 合同 | SHA256 |
|---|---|
| mode | c055866fad0e9b69cdd75c526eeb2fee6ad97899641d792be63037a064bf2411 |
| HTTP | 86825d6281da13fdf17c32b04d5c9dcb4edf71ceb69257d839aacb9df0a99f1e |
| fixtures | c58dd98ade3329d04e5c9b7622e7e4668c33483b38cd804f37257e5baa6d415b |


## 可复查证据与命令

证据目录：[evidence/p0-20261030](evidence/p0-20261030/)，入口 [validation-summary.json](evidence/p0-20261030/validation-summary.json)，全部文件摘要见 [SHA256SUMS.json](evidence/p0-20261030/SHA256SUMS.json)。原失败、e0补测、b7定向三个目录分开保留，不覆盖失败结果。导出仅清理多余文件末空行及构建失败日志一处行尾空白，原始采集保留于本轮state目录。仅归档合成样本和摘要，无二进制、数据库、现役.env内容或凭据。

- 最终构建/测试：[83输入与Git核验](evidence/p0-20261030/39-final-input-git-verification.json)、[完整Cargo](evidence/p0-20261030/39-final-linux.log)、[HTTP joint](evidence/p0-20261030/39-final-http-joint.log)、[主会话独立复验](evidence/p0-20261030/root-verification.json)、[只读源码/RTC评审](evidence/p0-20261030/worker-final-review.md)。
- RTC：[e0原始矩阵](evidence/p0-20261030/39-rtc-e0-matrix/run-manifest.json)、[e0租约补测](evidence/p0-20261030/39-rtc-e0-lease-targeted/run-manifest.json)、[最终b7延迟定向](evidence/p0-20261030/39-rtc-b7-delayed/run-manifest.json)；各含客户端四通道结果、Worker日志/单调时间、provider观察及运行exe身份。
- 产物：[兼容与隔离文件恢复](evidence/p0-20261030/39-release-final-stage-check.json)；目标机正式文件 `/opt/p003-listening-p0-20261030-session39/release-candidate`，测试版 `rtc-test-worker`。构建机正式产物 `/data/p003-listening-worker-check-20261030-session39/target/release/voice-rust-worker`。三处文件摘要已绑定上述b7输入。
- 现役/清理：[最终只读盘点](evidence/p0-20261030/39-production-after.json)、[精确房间查询](evidence/p0-20261030/39-rooms-after-cleanup.json)、[进程退出确认](evidence/p0-20261030/39-cleanup-confirmed.json)。

实际Linux命令在隔离源码 `voice/2-Projects/realtime-voice-agent/rust-worker` 执行，使用既有CARGO_HOME/独立target、`CARGO_INCREMENTAL=0` / `CARGO_BUILD_JOBS=2` / `P003_WORKER_BUILD_SHA=b7c942201d45a6fe92a26488448f4dfb0c1db4b0`，均持有 `voice/2-Projects/realtime-voice-agent/check.lock` 的flock；不拷缓存、不装工具链：

```sh
cargo test --offline --locked
cargo test --offline --locked --features listening-rtc-test transport_tests
# P003_LISTENING_JOINT_BUNDLE 指向已核33输入、f8c0...的当前Brain包
sh scripts/listening/run-joint.sh
```

软件设备实际命令（`--credentials` 仅指隔离文件路径，内容不输出）为 `/root/voice-venv/bin/python rtc-probe.py --credentials PRIVATE_PATH --fixtures ISOLATED_ROOT --output FRESH_RESULT --scenario SCENARIO`。e0运行七场景；最终b7只运行normal/lease_timeout并追加 `--mic-publish-delay-ms 11000`，各新签独立room/session/trace，订阅后持续上行，不拿日志“closed”代替客户端断开和精确房间API结果。

关键代码锚（相对 `rust-worker/`）：`src/worker.rs:173,197–220` 任务容量发布；`src/job.rs:405–448,507–563` 原统一收尾/有界删房；`src/pipeline.rs:666–681,944` ASR接管及 `4480` 后失败用例；`src/pipeline.rs:1945` 实际SpeechStart；`src/listening_http.rs:322` 默认/测试编译传输门。触及文件为上述四个Rust文件、Cargo.toml、build-local.sh、rtc-probe.py及两份Python测试，未改合同。修复链：c61656e7 → 68f2b586 → 7e75a73f → e0a83f81 → d9acb68b → b7c94220；文档提交不改变构建输入。

## 发布候选与恢复步骤（本轮不执行线上操作）

- 正式与测试特性二进制分开，不能用测试版上线。目标机 Ubuntu24.04 / x86_64 / glibc2.39，libstdc++ 供给 `GLIBCXX_3.4.33`；候选需求最高 `GLIBC_2.39` / `GLIBCXX_3.4.31`。最终产物另核 ldd 无缺库及空环境 loader fail-fast。
- 本轮实际只在隔离目录做文件替换/恢复演练：复制现役运行文件作唯一备份→替换为候选→恢复→核原 SHA；这不等于生产服务回滚或 Android 恢复验收。
- 未来触及的生产对象应限于普通池二进制及审核后的构建清单。普通 unit、三份环境文件、VAD/filler 资产、路由和搜索所有文件不应被整树覆盖。现役 unit SHA `fc4d00bc4d4a5fcdbdcfd2feed4e0ed658fa447d68904fd6951e725b3731c7d0`；搜索 unit SHA `d576a1fd7d0b0bf1c60c7b3e9f222237b7bd520c857a04f4d7e6eaae5e764835`。

经主会话另行验收、批准发布后，操作人先重读实际 PID、运行文件 SHA、unit/环境文件摘要、路由/总闸和活动房间。若与本回执不同，停止使用旧清单，重新核当前状态。源候选 SHA 与清单一致、普通池无活动房间后，沿用现有 stop→清 EOT socket→install→start 纪律：

```sh
# 仅为未来普通池操作步骤；本轮没有运行。
rollback_dir=/root/rust-worker/rollback-LISTENING-UTC_TIMESTAMP
install -d -m 700 "$rollback_dir"
cp -p /root/rust-worker/voice-rust-worker "$rollback_dir/voice-rust-worker"
sha256sum "$rollback_dir/voice-rust-worker" # 必须匹配发布前实际运行文件
systemctl stop voice-worker-rust.service
# 仅在确认本 unit 已停止且无关联进程后，按现役脚本清它自己的 EOT socket。
install -m 755 VERIFIED_DEFAULT_RELEASE /root/rust-worker/voice-rust-worker
systemctl start voice-worker-rust.service
# 核新 PID/实际 exe SHA、注册/config ACK；独立新房验四通道与自动收房。
```

失败时对同一普通池执行 stop，使用上述唯一备份 `install -m 755 "$rollback_dir/voice-rust-worker" /root/rust-worker/voice-rust-worker`，再 start；核恢复文件 SHA、原路由/闸及新会话。禁止拿不明 `.prev` 覆盖，禁止改搜索 unit/env/window。上述步骤尚未线上实操；代码层可回到本轮起点，新功能提交只存在专用分支。

下一步最小联调：主会话独立核最终证据与候选→安卓按已发 rev3 实现自动 proposal→原 enter/exit + local_ready→隔离 SN 新房实测本地停音、续讲、一次反馈、唱歌与重连；记录 room/session/trace、seq 和实听，仍不自动开线上闸。

署名：codex（OpenAI）| 2026-10-30 18:17:05 CST
