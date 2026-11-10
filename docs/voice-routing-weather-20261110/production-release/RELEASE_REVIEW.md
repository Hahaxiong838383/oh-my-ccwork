# P003 语音与天气｜最终发布门复核

结论：**可发布**。本门没有新增的发布阻断，也没有需要在发布前改的代码。

复核人只读核了候选包、固定提交和回滚记录，没有部署，没有改源码、配置或设备，没有连接生产，也没有重跑整仓测试或重编 Worker。运行代码仍是 Codex 所写。前三份 Grok 审查（主池、Brain/UI、倾听池）维持无阻断；它们指出并已修复的取消竞态，以最终二进制和 `REVIEW_RESOLUTION.json` 为准。

线上 before/backup、活跃房间，以及发布后的 `/proc` SHA、健康、配置、公网预览和语音探针，由主 13 在发布当时执行。2026-11-10 05:02Z 的备份快照和 05:47–05:49Z 的隔离语音前后 PID 记录，说明当时生产文件未被这批候选换掉；它们不代替发布当时的核验。

复核时间：2026-11-10 14:13:38 CST。

## 阻断

无。

已证的新缺陷：无。发布前建议改动：无。

## 固定候选

| 对象 | 运行源码 | 分支 HEAD | 产物 SHA-256 |
|---|---|---|---|
| 主池 Worker | `148107232d1792c2c39719113d49031c67170d13` | `937dd7d631feb730eda7de1cee39445c081a788a` | `8a9534897303b8f12406df47a51bf70dba8d26ef44efd56e27db4601f5ea50a9` |
| 倾听池 Worker | `fd3ad604c64079b607fbfc285c5d7c9baf2002df` | `37afa96201ba2432ee9614f66cb1698df0593f94` | `517f5290eeb73486ccb3bcf86e16eec24bde5b6380d825851592c1f308f5f305` |
| Brain 业务 | `15d07e6161dcd083d12501cd37d9511cad489427` | `9ffc5c160c15bd287b432ee0143fc5820f1242dd` | 见下方 4 个 Brain 文件 |
| 回滚标签 | 主池 `rollback/p003-voice-routing-pre-20261110` = `f0380202eb93303bc69563d37c08bab6f3f9d0fa`；Brain `rollback/p003-weather-preview-pre-20261110` = `62d840c2e347d65bec1de4ddf523b6a2a7c117d6`；倾听池 `rollback/p003-voice-routing-listening-pre-20261110` = `ac18707965623b85540408fc1d989eacb04ce798` |  |  |

三个工作树本地干净。三个运行源码各自的 merge-base 就是上表基线。主池 `14810723` 与倾听池 `fd3ad604` 的共同祖先是 `8a34369413035470a929418f1dcd48f1f9ebed57`，谁也不是谁的祖先。

## 制品

候选包：

`/Users/fu-121/.local/state/p003-voice-routing-weather-execution-20261110/p003-voice-weather-candidate-20261110.tar`

SHA-256 `7a217fcc0d023f668e0c24ba78bead7cd15fedeec6d0eb00e9a6ae623bfad024`，53,923,840 字节，与 `BUNDLE_RECEIPT.json` 一致。包内 `DEPLOY_MANIFEST.json`、`BUNDLE_INDEX.json`、`DEPLOY_ROLLBACK.md`、`check_manifest.py` 与证据根同字节，也与三条分支 HEAD 里归档的清单同字节。

解压后 7 个载荷的内容 SHA-256 与字节数同时等于 `BUNDLE_INDEX.json` 和 `DEPLOY_MANIFEST.json` 的 `after_sha256`。7 个 after 互不相同，也都不同于对应 before。三个 ELF 都是 x86-64 Linux PIE。

| 目标 | after SHA-256 | 字节 | 格式 |
|---|---|---|---|
| `/root/rust-worker/voice-rust-worker` | `8a9534897303b8f12406df47a51bf70dba8d26ef44efd56e27db4601f5ea50a9` | 76,329,944 | ELF，BuildID `761ba9b48361413f0d16d9394e2de6a9c301ea82` |
| `/opt/p003/server/src/tools/weather-places.ts` | `31549c3c36450b77caa377d20d900300df5a34b21affa8bfa69b600492f28f3a` | 2,743 | 与 Brain `15d07e61` 和 HEAD 的该文件同字节 |
| `/opt/p003/server/src/routes/search-routing-admin.ts` | `6c5b38ff9d47602238311493bff8c543eb64a509d106d4b23b531dc3eb4699ab` | 5,464 | 同上 |
| `/opt/p003/web/dist/admin/index.html` | `491ad58daab6e9319a9df21e4c28f07191999bc09500b7491ad99b5f5ceb8267` | 729,453 | 与已审查的 `public/admin/index.html` 同字节；含「本版本未提供地点详情」「不请求天气」`place_inspection` `weather_catalog` |
| `/opt/p003/server/bin/search-route-preview` | `5cedfef79540b28a25c3275d409ce40446da99448457dd5cb822d94b032d0f50` | 997,560 | ELF，BuildID `50307eafb6156d36e2bb79e0232de515ab5b2499` |
| `/opt/p003-listening-canary-20261030/voice-rust-worker` | `517f5290eeb73486ccb3bcf86e16eec24bde5b6380d825851592c1f308f5f305` | 78,225,912 | ELF，BuildID `0a213037df090714b040174554dae501d215aa1f` |
| `/opt/p003-listening-canary-20261030/release.json` | `594fe0fb2f1dbd1fc125461ef01b9627de224108cd339b055d4cd536551f8eb2` | 170 | `build_sha=fd3ad604…`，`binary_sha256=517f5290…`，`bytes=78225912` |

旧独立搜索池二进制 `56f6878f1a232139f8bba968af3a2331c03bb842ad87228a8f63a01ed77ec53c` 不在清单和包内。

## 池隔离

四份路由源码在两个运行提交上的 SHA-256：

| 文件 | 主池 `14810723` | 倾听池 `fd3ad604` |
|---|---|---|
| `ordered_pcm.rs` | `abe02f2e979401785156fd2f63b2e7afdea66c15b9b7ef93eb345f11446bc541` | 同左 |
| `search_policy.rs` | `ac05fdb1013d05f986d7d7119ffa6486f6ed536880731278c159051efcf66ee6` | `b799e076e53461ab9a69b2a980a2bb1d9fd01e5eb4c9496e6d19cb48b2436165` |
| `search_routing.rs` | `394113db4dc32a96f51c2afc2f5d101baec32fd81eb82e0d94f5eae3e1a46901` | `71ad2d36de7b6cce2ed48904b361c6865bc1e35f6769d8147eb57b7e7bc64313` |
| `search_tasks.rs` | `c5922ecd8f788b064a6b4d7f92b580178c310931d14147051068c098962e3574` | `16e4ee7efde1b1aeb4d48a8395533ae6e8a25abfe1200e69003de4dfbc02aa9d` |

`ordered_pcm.rs` 两池相同，是同一份首句过滤。`search_policy.rs`、`search_routing.rs`、`search_tasks.rs` 两池不同。主池策略源码没有「不要查了」；倾听池有。主池提交没有 `listening_adapter.rs`；倾听池提交有。地名目录两池同为 `40f4cc66ff051ab205e9299e7b13bf458b62b28b4ce9e6e8e3a7a141b7ded69b`。`source-all-reviewed.json` 与 `source-reviewed-release.json` 同字节（77 个文件）；倾听池对应两份同字节（84 个文件）。

二进制侧：倾听池 ELF 内含提交号 `fd3ad604c64079b607fbfc285c5d7c9baf2002df`，并含「不要查了」「帮我查一查」「帮我搜一搜」。主池 ELF 和预览 ELF 都不含这个提交号，也不含这三句。两份 Worker 的 `ordered_pcm::Session::on_stream_end` 都有「可小可」「呃小可」「额小可」的 9 字节比较。预览程序是主池路由引擎的配套件，随 Brain 发布。

主池 ELF 没有把 `14810723` 写进文件。它和源码的对应关系是：`CANDIDATE.json`、`FORMAL_MAIN_REVIEWED_RESULT.json` 的 `binary_sha256` 都是 `8a953489…`，76,329,944 字节，且上面四份源码哈希与 `14810723` 一致。本复核没有重编。

## 分支 HEAD

| 分支 | `reviewed..HEAD` |
|---|---|
| 主池 `937dd7d6` | 只新增 `docs/voice-routing-weather-20261110/`。四份运行源码与 `14810723` 同字节。 |
| 倾听池 `37afa962` | 只新增同一批文档。四份运行源码与 `fd3ad604` 同字节。 |
| Brain `9ffc5c16` | 文档，外加测试脚本 `search-routing-preview-ui.cjs` 一行夹具，以及新测试 `weather-compiled-http.test.ts`。 |

Brain 的 `weather-places.ts`、`search-routing-admin.ts`、`public/admin/index.html` 在 `15d07e61` 与 `9ffc5c16` 同字节，并与包内载荷一致。`fixed-weather.ts`、`search-runtime.ts`、`search-routing-config.ts` 在基线 `62d840c2`、`15d07e61`、`9ffc5c16` 三处同字节。天气供应商仍是主池百度加墨迹。新测试把预览的供应商调用数断言为 0，把执行路径的桩限制为 `weathernew.pae.baidu.com`，并写明 `real_device: false`。

## 回滚

`DEPLOY_MANIFEST.json` 的 7 个目标都有 before、after、backup 和 mode。倾听池二进制与 `release.json` 成对，备份在 `/root/p003-voice-routing-weather-20261110/baseline-20261110T050228Z/`。Brain 两份 TS 和 `index.html` 的备份在 `baseline-20261110T050230Z`。预览程序的备份在 `preview-supplement/search-route-preview`，因为旧程序当初不在那次源码备份里。

`ONLINE_BEFORE_AND_BACKUPS.json` 记录当时 7 个线上文件加 7 个备份共 14 项 SHA 全部吻合。`MANIFEST_GUARD_TEST.json` 记录 before/backup/after 为 0、人为漂移为 1。本复核在临时目录用包内 `check_manifest.py` 复现了一次：合成的 after 与 backup 退出码 0，改动一个 after 文件后退出码 1。没有对生产主机执行它。

回滚顺序在 `DEPLOY_ROLLBACK.md` 里是完整的：先停扩大并恢复本批设备范围；用 `--mode after` 确认当前仍是本批，且 backup 仍等于 before；只把这 7 个备份原子换回并恢复 mode；主池和倾听池分开，倾听池二进制与 `release.json` 成对；Brain、页面和预览独立恢复；空闲后再重启，并核 `/proc` SHA。源码用上面三个标签，生产用上述文件备份。env、数据库、owner，以及今天既有的 DNS、TTS、灾备配置不在这批回滚里。

## 已接受的既有失败

这两条 Brain 失败和 12 个 TypeScript 错误保持原基线，供应商策略不变。

| 证据 | 结果 |
|---|---|
| `tsc-baseline.log` 与 `tsc-candidate.log` | 同字节，SHA-256 `4ab70e064cd2ef96dc8bea4b5e2f32dca1c83e2d1f5f52d013f3aa05b9f559f7`，`error TS` 12 条，位于既有 `amap-weather.ts` |
| `fixed-weather` | 基线日志 `6ee1f70f3f86a8b59fb5a33612d01e1bfa8e3edcf641d1dcec1525196e28ee3b`，候选 `2bab28185db2ceb30a9681c78cbd3aaf31c46aac41ae913fb04df386a2011f78`，与 `KNOWN_BASELINE_FAILURES.json` 一致 |
| `search-weather-fallback-runtime` | 基线 `bfa169c861d0b10f506b85a8a13a84b5f3b8ee1a758cf821c469cea4d79cd126`，候选 `a5e46b92bed6c45eb97053a26044b8a197240220676f49c7650623f660245c31`，同上 |

`HTTP_RESULT.json` 的预览用例通过，目录 `40f4cc66…`、站号 `101280601`，供应商是冻结桩，`real_device` 为 false。正式语音主池 3/3、倾听池 2/2 的 `candidate_sha256` 就是上面两份 Worker；隔离进程、合成 LLM 和 SN、真实 ASR/TTS，`real_android` 为 false。

## 未关闭边界

这些边界保持开放。它们不构成本门的发布阻断，发布说明里也不要写成已经关闭。

1. `ResumeLatest` 加上取消 HTTP 失败、再一次提交失败的跨房复合路径，没有端到端故障注入。普通新任务替换旧 resume entry，与旧任务 poll 隔离分开记账。
2. 音频局部近静音和吞前段仍待同一句真人录音与安卓同机 PCM 对齐。服务端音轨有声不等于扬声器听感通过。
3. 隔离正式语音和冻结天气桩不代表真实供应商天气、真实 LLM 回答或生产派单已经通过。
4. 旧独立搜索池不在本批，不能并入本候选的通过范围。

## 上线检查

主 13 发布时按这个顺序做。任一 SHA 不符或当时有活跃房间，就停在该步。

1. 指定体验设备和时间，核实际派单池、配置 revision、原设备范围、agent/build。本批不改设备开关，不打开其他设备的搜索、倾听、定位或诊断。
2. 在对应主机重跑 `check_manifest.py --mode before` 和 `--mode backup`。确认该池没有活跃任务；有房间就延后。再核候选包 `7a217fcc…` 和解压后的 7 个 after SHA。
3. 先换 Brain 的两份 TS、`index.html` 和 `search-route-preview`，按现有流程核健康。Worker 按池原子替换。倾听池的二进制与 `release.json` 一起换，保留原 agent、env 和 unit。
4. 只重启本批进程。核 `/proc/<pid>/exe` 的 SHA 等于上表 after，并核健康租约、签票 build、真实 assignment、公网预览和语音探针。磁盘文件 SHA 通过之后仍要做这一步。
5. 回滚时先 `--mode after`，确认 backup 仍是 before，再按池恢复。恢复后核 `/proc` SHA、普通问答、取消、倾听退出、关房重入。
6. 业务灰度至少 7 天。录音诊断若开，单台 30 分钟、200MB，起止用真正开窗时刻。

署名：grok（xAI）｜只读最终发布门｜2026-11-10 14:13:38 CST
