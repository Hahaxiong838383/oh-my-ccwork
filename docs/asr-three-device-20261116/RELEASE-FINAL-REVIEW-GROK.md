# d53 显式 rollback 启动失败恢复复验

审查对象：固定提交 `d53dd824497fada79e3cf151b0134c0b18458d45`。父提交 `913e6bd01584a6851579341dd265be14a266945d`。行为对照基线是 `579e8a15e28c83a8c68af54103a44b7df1df7195`。材料来自 `git show` / `git archive` 目录 `/tmp/grok-d53-review`。测试加载的是该目录里的脚本，工作区文件没有当作候选。

署名：grok（xAI）| 2026-11-16

## 索引

- 结论：`isolation_pass`。阻断：无。
- 范围：只覆盖这一固定 SHA 的发布脚本隔离验证。生产 apply、真实 systemctl、Rust 与候选二进制都没有在本轮执行。
- 相对 579，环境 helper 与回执脚本 blob 未变。`rust-worker` 无差异。候选记录仍是源 `262dfe9c0a7bc9c44769670e0312bcb66cb32671`、二进制 `d37a39633ed8e7766e35744baf0b78ca2fbc12777a91b9a89f166029748c1c69`。
- 代码变化是 `deploy_asr_diagnostics.py` 的显式 rollback `try/except/finally`，以及配置锁改由 `with` 关闭。新增 `test_asr_diagnostic_deploy.py`。
- Python：归档上 13 + 19 + 6 = 38，0 失败。Python 3.12.2 与 Python 3.9.6 各跑一遍，`-W always` 下 ResourceWarning 为 0。
- 579 脚本配上这 6 项发布模拟：5 项通过，`test_failed_explicit_rollback_recovers_pre_rollback_candidate` 失败，断言为 `b'main-original' != b'reviewed-main'`，并出现未关闭的 `env.config.lock`。
- 同一提交里的 `docs/codeg-worktree-visibility-20261116/manifest.json` 与 `PUBLICATION-MANIFEST.json` 不在本结论内。
- 未 commit，未 push。工作树在落盘时干净，HEAD 仍是该 SHA。

## 结论

显式 rollback 在旧二进制已换上、但启动后没有注册成功时，会把切换前读到的候选字节写回去，把两项诊断键按切换前的值放回当前环境文件，保留文件里的其他键，再启动并核对注册。回执写入 `ROLLBACK-<pool>.json`：`rolled_back` 为 false，并带上 `recovered_candidate`。调用本身仍抛出原来的 `RuntimeError: worker failed registration/health`。

二进制、发布元数据，或两项诊断键在恢复前被别人改过时，恢复断言失败，回执只记 `recovery_error_type=AssertionError`，不把候选二进制或诊断键盖回去。配置锁在异常回到调用方时已经释放：另一个进程可以立刻 `LOCK_EX|LOCK_NB` 拿到同一把锁。

这是临时目录里的模拟。systemctl、journalctl、hostname 和房间 API 都由测试替身应答。它不证明生产机已经回滚，也不证明两个版本都无法注册时服务器会自动变健康。

## 固定 SHA

`git show --stat d53dd824497fada79e3cf151b0134c0b18458d45` 归档在 `/tmp/grok-d53-review/show/git-show-stat.txt`，脚本与新测试的 diff 在 `show/git-show-code.diff`。

| 路径 | 相对 579 | 内容 SHA256 | git blob |
|---|---|---|---|
| `scripts/deploy_asr_diagnostics.py` | 本提交改写 | `7f69faa65170bfe98aee220cfcdd7b5b517609727e1b75c6b1fa53ac7619d466` | `e67ab0f354c4392d6d2d282b0f3599b717db3654` |
| `scripts/asr_diagnostic_env.py` | blob 相同 | `46498b02a81fce1f22929c7ff14b04cc209034b84db2cec753b558b26e564888` | `ee106757c629d140c8fff8702287a3b3f918fb02` |
| `scripts/asr_diagnostic_receipt.py` | blob 相同 | `376c6bb43e273aadc8c55324a0e8a25b65e6c8b98ea84cab181a8a7a0ee6f0a6` | `fc85212aaefea9ed11acd594c103a6b4c34e3d69` |
| `tests/test_asr_diagnostic_deploy.py` | 本提交新增 | `91f6d5ffe36d546d13f6bfb0b7f71a51292a8d33b14cf1804d161ad92aff566c` | 随归档 |
| `tests/test_asr_diagnostic_env.py` | blob 相同 `66c2b5035c91b2db06addea9ede619bbf9409f14` | `ec75ca23efea238950551a2fcdc43abba2ec1e8d6af5593f7636eadc2997d679` | 同上 |
| `tests/test_asr_diagnostic_receipt.py` | blob 相同 `0977596f22435aa64b41627f701122d6c32c3e6e` | `6b4118e8ec4d03e099ea88f81f2a283b5f924fe3e365eae5300c58533cb37fb4` | 同上 |

579 的发布脚本内容 SHA256 是 `fc8a60e273caf9acd67d04a2b14eb2fbdbf8d70c25d5744c9bd31fe5fc744c15`，blob `b784fad8172542f0525c2f2b33affdae059ebb4d`。`git diff --name-status 579 d53` 在 helper、回执脚本和 `rust-worker` 上没有输出。

## 38 项与 6 项发布模拟

命令在归档的 `2-Projects/realtime-voice-agent/tests` 下执行：

`python3 -W always -m unittest discover -p 'test_asr_diagnostic_*.py' -v`

| 解释器 | 结果 | 日志 SHA256 |
|---|---|---|
| Python 3.12.2（`/opt/anaconda3/bin/python3`） | `Ran 38 tests in 0.513s`，`OK`，ResourceWarning 0 | `77fc8b8a34a56787ece0059801ecb03f7aafd56e6b6009c9b1cf033a01ac0edb` |
| Python 3.9.6（`/usr/bin/python3`） | `Ran 38 tests in 0.652s`，`OK`，ResourceWarning 0 | `da32d95bf2fc99b0578108de261c02a94606f2b2f5d0ed1e92e3ddf2bfe4bd9d` |

分组：环境 13、回执 19、发布模拟 6。六项名称都是 ok：

- `test_main_apply_and_rollback`
- `test_listening_only_env_changes`
- `test_failure_rolls_back_without_erasing_rotated_key`
- `test_busy_cleanup_never_stops`
- `test_runtime_drift_never_stops`
- `test_failed_explicit_rollback_recovers_pre_rollback_candidate`

6 项都在临时目录里替换了 `subprocess.run`、`subprocess.check_output`、时钟和 `/proc` 路径。忙时清理与二进制漂移两项的 `stops` 保持 0。房间列表来自测试里的假 `RoomAPI`。

## 579 上的失败实例

把归档里的发布脚本换成 `579:deploy_asr_diagnostics.py`，其余测试不动，同一条 discover 只跑发布模拟。Python 3.12.2：`Ran 6 tests`，`FAILED (failures=1)`。日志 SHA256 `6c00a2f285e48d775abcfaecdb084833b12e6f959bb3712394a8bc30dab99904`。

失败点在新测试第一项断言：

`AssertionError: b'main-original' != b'reviewed-main'`

旧脚本在显式 rollback 里先换成旧二进制并去掉诊断键，`start()` 抛错后没有恢复路径，锁文件也没有关闭。`-W always` 打出 18 次 `ResourceWarning: unclosed file ... env.config.lock`。其余 5 项在这个旧脚本上通过。d53 的 38 项日志里没有这句 ResourceWarning。

## 本轮追加的隔离探针

探针仍加载归档里的 d53 脚本和现有 `ReleaseSimulation`，只在第二次 `systemctl start`（旧版本启动）返回后改临时文件。结果在 `/tmp/grok-d53-review/probe.json`，SHA256 `b68fd666a3ce97cf3f7b2472f37bed8724df3f6619933dd16b5b0fa824f826fd`。进程退出码 0。

| 探针 | 观察到的结果 |
|---|---|
| main 旧版本不注册 | 二进制回到 `reviewed-main`；`LLM_KEY=old-test-value` 与 `LIVEKIT_URL=wss://test.invalid` 仍在；五项合成 SN 的诊断键回到环境文件；服务替身 `active`；listening PID `101`、search PID `102`；回执有 `recovered_candidate`，`rolled_back` 为 false |
| 只改 `LLM_KEY` 为 `other-writer-value` | 候选二进制恢复；该键保持别人写入的值；诊断键恢复；`LIVEKIT_URL` 仍在 |
| 诊断键被写成 `BJP00326111600000099` | 二进制保持 `main-original`；外来诊断行还在；没有 `recovered_candidate`；`recovery_error_type` 为 `AssertionError` |
| 二进制被写成 `third-party-binary` | 磁盘保持这 18 个字节；诊断键没有被写回；元数据保持回退时已写下的 `old-test` |
| 元数据被写成 `other-writer` | 二进制保持 `main-original`；元数据保持 `other-writer`；没有恢复成带 `262dfe9c` 的发布元数据 |
| 暂存 `worker-candidate` 被换成 `poison-candidate` | 写回的是切换前读到的 `reviewed-main` |
| listening 旧启动不注册 | 二进制保持 `listening-original`；诊断键恢复；main PID 保持 `100` |
| 旧启动和随后的候选启动都不注册 | 磁盘上的二进制和诊断键已回到切换前内容；回执 `recovery_error_type` 为 `RuntimeError`，没有 `recovered_candidate` |

每一例在 `main()` 把异常抛回测试之后、测试进程仍活着时，子进程对 `env.config.lock` 的非阻塞排他锁返回 0。

## 交给主 13 的边界

本地 `SPEC-FINAL-PENDING.json` 里的 `deployer_sha256` 已等于 d53 脚本内容哈希 `7f69faa6…`，`helper_sha256` 等于未改的 helper，`binary_sha256` 仍是 `d37a3963…`，`reviewed` 仍是 false。本轮没有改 SPEC，没有把脚本送到服务器，也没有重做空房、健康或现役源检查。

用户已说明五台 SN 都是 active。本轮发布模拟用的是 `BJP00326111699999901` 到 `05`，没有再查设备。

恢复成功时进程仍以原来的注册失败异常结束。要区分“已回到候选”和“仍停在旧文件”，看 `ROLLBACK-<pool>.json` 里的 `recovered_candidate`。两个启动都不注册时，脚本不会再找第三个状态。apply 失败后那条内部回滚若旧版本也起不来，走的仍是 579 里的路径；这次新增的恢复包在显式 `rollback` 上。

发布说明里的模拟通过，与这次独立复跑的 38 项方向一致。作者日志 SHA256 `ccfc6177…` 不是本轮日志，本轮数字以上表为准。
