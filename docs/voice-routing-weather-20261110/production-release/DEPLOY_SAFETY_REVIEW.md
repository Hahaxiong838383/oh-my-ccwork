# 部署安全复核（脚本与补充 metadata）

审查者：Grok（xAI）  
日期：2026-11-10  
范围：本目录部署脚本与倾听 metadata 补充。不重复另一任务对固定候选和 7 文件包的审查。  
未做：SSH、部署、改源码、生产切版、真机或 Android 验收。下文「可执行」只表示按脚本静态审查可以进入 Codex 的生产操作，不表示生产或真机已经通过。

## 判定

**可执行。无阻断项。**

正向脚本的写入目标与两池边界正确，补充 metadata 只改约定字段，且有独立回滚入口。已记录的 `--check` 结果与脚本门闩一致。切生产仍要按下面的顺序和回滚配对执行。脚本没有把整条顺序编成一把锁。

## 身份与写入边界

| 对象 | 身份 | 谁写 | 写入路径 |
| --- | --- | --- | --- |
| 主池 Worker | `148107232d1792c2c39719113d49031c67170d13` / `8a9534897303b8f12406df47a51bf70dba8d26ef44efd56e27db4601f5ea50a9` | `deploy-pool.py main` | `/root/rust-worker/voice-rust-worker` |
| 倾听池 Worker | `fd3ad604c64079b607fbfc285c5d7c9baf2002df` / `517f5290eeb73486ccb3bcf86e16eec24bde5b6380d825851592c1f308f5f305` | `deploy-pool.py listening` | `/opt/p003-listening-canary-20261030/voice-rust-worker` |
| 倾听池本地 release | 旧 `build_sha` 门闩 `ac18707965623b85540408fc1d989eacb04ce798`；新文件 `594fe0fb2f1dbd1fc125461ef01b9627de224108cd339b055d4cd536551f8eb2` | 同上 | `/opt/p003-listening-canary-20261030/release.json` |
| Brain 四文件 | `15d07e6161dcd083d12501cd37d9511cad489427` | `brain-deploy.py`（`host==brain`） | `weather-places.ts`、`search-routing-admin.ts`、`web/dist/admin/index.html`、`bin/search-route-preview` |
| Brain 倾听权威 | 旧 SHA `7754f69d17c1a66bc52039cb1dd7ed89b0e0c65c9a54c2da3f1d2a3385b12068`；新 SHA `b649d23cc54c91693096be21d1ebad0d614049a9eabc4913beaed42fa36fda51` | `listening-metadata.py` | `/opt/p003/listening-canary-20261030/listening-release.json` |

`DEPLOY_MANIFEST.json` 共 7 项，其中 Brain 4 项。清单里没有 `/opt/p003/listening-canary-20261030/listening-release.json`。`brain-deploy.py` 因此不会改这份权威。Worker 脚本写的是另一路径上的 `release.json`。两份文件必须分开备份、分开回滚。

本目录字节核对（本地文件，不是重新登录生产）：

- `brain-listening-manifest-after.json` SHA256 = 计划 `after_sha256` `b649d23c…fda51`。
- 与已捕获的旧权威相比，只差 `agents[0].build_sha`（`ac187079…` → `fd3ad604…`）和 `evidence_ref`。`version`、`expires_at_ms`、`agent`、六项 `capabilities` 相同。
- `listening-release.json` SHA256 = 清单 `594fe0fb…f8eb2`，内容是 `build_sha=fd3ad604…`、`binary_sha256=517f5290…`、`bytes=78225912`。
- 旧权威捕获 SHA = 计划 `before_sha256` `7754f69d…12068`，模式 `0o600`。

`expires_at_ms` 仍是 `1794391200000`，即 **2026-11-11T10:00:00Z**。脚本按要求保留它，也不判断是否仍未到期。倾听 metadata 的正向和回滚都要在这个时刻之前做完。

`METADATA_RELEASE_PLAN.json` 里的 `p1_display`（`/opt/p003/server/data/search-p1/release.json`）没有被这批脚本写入。`scope`、`real_device_acceptance`、`performance_acceptance`、`opened_at_ms` 保持原样。两段生产语音 probe 完成之前不要做这项刷新。

## 正向门闩

`brain-common.idle` 会拒绝仍有 LiveKit room 的情况，并拒绝 `p1.tasks.recent` 里 `queued` 或 `running`。`brain-deploy.py` 在 `--check` 和真正替换前都会调用它。`listening-metadata.py` 的正向路径也会调用它。

`deploy-pool.py` 另有空房检查。主池再用当前 PID 的 journal 把 `job assignment received` 与 `process exiting` 配对。倾听池要求 `health.json` 的 `registered`、`jobs==0`、`cleanup.healthy`，且 `at_ms` 在 6 秒内。两池各跑两轮 guard + idle。`--check` 只打印后退出，不写运行文件。

其他正向约束：

- `updates` 为空。env 文件和 unit 只备份。启动后核对进程里 `P003_`、`VOLC_`、`LLM_`、`TTS_`、`XFYUN_`、`AGENT_`、`WORKER_`、`LIVEKIT_`、`EOT_`、`VAD_` 前缀未变。
- 另一池 unit、`p003-search-worker`、search `canary.env`、listening `window.json`、`v374-window.json`、本 unit 的 service 文件哈希被钉住。
- 主池 `meta is None`，不会写倾听 `release.json`。倾听池先要求旧 `build_sha==ac187079…`，再整文件换成 `listening-release.json`。
- Brain 替换后要求 `/health`、`runtime.ready`、配置快照相等、`.env.local` 哈希不变、其他 pm2 进程不变。失败时按清单 backup 把已改文件写回并重启 `p003-voice`。
- metadata 正向先证明新 JSON 等于旧 JSON 只改 `build_sha` 与 `evidence_ref`，再要求文件 SHA 等于计划。失败且文件已是新 SHA 时写回旧字节。
- 一次成功或失败都会留下 receipt。已有 receipt 时正向脚本拒绝再跑。

已有干跑记录（本次没有重跑）：`brain-precheck.json` 为 4 文件 PASS、`idle=true`；`worker-precheck.json` 主池与倾听池均为 PASS、`idle=true`；`brain-metadata-precheck.json` 为 PASS，`capabilities_preserved=true`，`expires_at_ms=1794391200000`。三份配置哈希都是 `0d89d26325b3718bce0115223b5ff482fd585fb22d2f140ec85623665b511fbc`。

## 回滚配对

倾听一旦两边都切过，回滚要成对，中间保持空房、倾听 `jobs==0`、p1 recent 无 `queued`/`running`。

| 已完成的步骤 | 回滚动作 |
| --- | --- |
| 只切了 Brain 四文件 | `brain-rollback.py --apply`。它会调用 `c.idle()`，只恢复清单里 4 个 Brain 路径。 |
| 只切了主池 Worker | `rollback-pool.py main` 先检查，再 `--apply`。只恢复主池二进制。env 只断言未变。 |
| 只切了倾听 Worker，Brain 权威仍是 `7754f69d…` | 只跑 `rollback-pool.py listening`。此时 `listening-metadata.py --rollback` 会因当前 SHA 仍是旧值而拒绝。 |
| 倾听 Worker 与 Brain 权威都已切到 fd3ad | 先 `listening-metadata.py --rollback`，再 `rollback-pool.py listening --apply`。只做一边会留下权威 `fd3ad604…` 对二进制 `ac187079…`，或相反。 |
| metadata 正向失败并已自动写回 | Brain 权威回到 ac187，倾听 Worker 仍可能是 `517f5290…`。要中止整段倾听发布时，再手动回滚倾听 Worker。metadata 脚本不会连带停 Worker。 |

`rollback-pool.py listening` 恢复的是 `/opt/p003-listening-canary-20261030/release.json`。`listening-metadata.py --rollback` 恢复的是 `/opt/p003/listening-canary-20261030/listening-release.json`。备份 SHA 必须分别是部署前的旧文件。

## 操作顺序

Codex 独占生产操作。每步单独执行，上一步 receipt 成功后再进下一步。

1. Brain 四文件：`brain-deploy.py`（已有 `--check` PASS 后才去掉 `--check`）。
2. 主池 Worker：`deploy-pool.py main`。
3. 主池生产 normal 语音 probe：`production-runner.py main`。
4. 倾听 Worker：`deploy-pool.py listening`。
5. Brain 倾听 metadata：`listening-metadata.py`。
6. 倾听生产 normal 语音 probe：`production-runner.py listening`。

第 4 步和第 5 步之间权威仍是 ac187、Worker 已是 fd3ad。空闲时马上做第 5 步。第 6 步之前核对 Brain 文件 SHA 已是 `b649d23c…fda51`，且 `agents[0].build_sha` 为 `fd3ad604c64079b607fbfc285c5d7c9baf2002df`。runner 自己不查这个文件。

任一步失败就停，按上一节只回滚已经成功的层。不要在 probe 尚未完成时刷新 p1 display。

## 操作注意（非阻断）

1. `listening-metadata.py --rollback` 不调用 `c.idle()`。执行前自行确认无 room、p1 recent 无 `queued`/`running`。正向路径有这个检查。
2. `rollback-pool.py --apply` 只查 LiveKit room。它不查倾听 `health.json` 的 `jobs`，也不查主池未完成 job，也不查 p1。`deploy-pool.py` 里的自动失败回滚对倾听池仍用 `health.json`。手动回滚更弱。
3. 倾听池手动回滚的就绪条件是 journal 中出现 `registered worker`。正向倾听就绪看的是 `health.json`。若回滚已经换成旧二进制并 start，随后健康等待失败，不要立刻再跑 `--apply`：此时 SHA 已是旧值，脚本开头的 `new_sha256` 断言会拒绝。改为核对进程 SHA `1193dfd3…` 不适用于倾听；倾听旧 SHA 是 `1fd53248c38ab38250c3fa703e98c8f2077619d5b5a7d36339132f6c9b6d79e5`，`release.json` 的 `build_sha` 应回到 `ac187079…`，`health.json` 应 `registered` 且 `jobs==0`。
4. metadata 写入不重启 `p003-voice`，成功条件是文件 SHA、配置快照不变、`runtime.ready`。`ready` 可能本来就是 true。第 6 步 probe 才是这次热更新的运行检验。probe 失败时先核对权威 SHA，再决定是否成对回滚。
5. Brain 配置快照不含 `routing.locations` 和 `routing.eligible_sns`。脚本不能单独证明 device 范围未变。`.env.local` 与其余已纳入的 device/p1/listening 配置被要求前后相等。
6. p1 空任务只扫描 `tasks.recent`。recent 若不是全部活动任务，门闩会漏。以该接口的实际全集为准。
7. `production-runner.py` 在开 probe 前只断言无 room，并要求进程 SHA 已是候选、结束时 unit 与开跑前相同。`passed` 不消费 `panicked`、`CaptureFailed`、`ERROR` 计数。probe 使用合成 SN，结果文本写明 `real_android: false`。FUNCTIONAL_PASS 不能当成真机通过。`production-{pool}` 目录已存在时 runner 会在开跑前失败；保留现场，不要为了重跑删掉证据，除非已另存。
8. 主池与倾听池共用 `deploy.lock`，Brain 四文件与 metadata 共用 `brain.lock`。两把锁互不覆盖，顺序靠操作而不是脚本。
9. Brain 四文件失败路径会重启 `p003-voice`，但进程内回滚不等待 `/health`。需要人工回滚时用 `brain-rollback.py`，它会等健康检查。自动回滚已经把文件写回旧 SHA 之后，不要再对同一批文件跑 `--apply`。

## 证据边界

本次只读了指定脚本、清单、计划和本目录已有的干跑/快照 JSON，并在本地计算了 metadata 文件哈希。没有新的生产运行结果。生产是否切成，以 Codex 每步 receipt 和 probe 的 `FUNCTIONAL_PASS` 为准。那个通过仍是合成房间里的生产链路检查，不是真机验收。
