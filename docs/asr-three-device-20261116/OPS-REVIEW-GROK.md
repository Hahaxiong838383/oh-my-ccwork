# ASR 发布准备增量独立复核（Grok）

审查对象：固定提交 `d09b3cb66df4ec99a6efcb0d8d2e93e6d6e5d0b1`。基线 `fab1dbd2599c311cc5ccaf371ed73890fad5dd26`。运行候选仍为 `262dfe9c0a7bc9c44769670e0312bcb66cb32671`，二进制 `d37a39633ed8e7766e35744baf0b78ca2fbc12777a91b9a89f166029748c1c69`。只读。未改业务源码、未操作生产、未发送设备事件、未改其他工作树、未 commit/push。未输出任何 env 正文。

署名：grok（xAI）| 2026-11-16

## 结论

本固定提交相对基线恰好 6 个路径。配置纯函数隔离验收通过；生产、真机、安装、三台名单均未通过。

`d09b3cb6` 的 `enable()` / `restore()` 只处理 `P003_ASR_DIAGNOSTICS_SN_ALLOW` 与 `P003_ASR_DIAGNOSTICS_UNTIL_MS`。无文件、网络、锁、原子安装、备份、空闲检查或重启。调用方仍须承担这些步骤。主测 Python 29 项在从该提交 `git show` 抽出的隔离目录重跑为 OK。独立反例确认：轮换后的凭据和其他键保留、只恢复原两键、诊断键重复/跨行/尾无换行拒绝、诊断配置漂移拒绝。

函数实际局限：只对已经匹配这两键的行做 `shlex` 与续行检查。其他键的跨行引号或反斜杠续行，若下一行看起来像诊断赋值，`d09b3cb6` 会把它当诊断键改写。这不是 29 项主测的失败，也不是用户点名的两键反例失败。它禁止把该函数当成对任意现役 env 自动安全改写。调用前必须人工确认现役文件无续行、无跨行引号。本评审没有打开生产 env 正文做该确认。

checkpoint 备份存在，只证明远端取证时主池与倾听池有受控副本、搜索池只读记录。这不是 `restore()` 已对生产 env 真实演练，也不是安装/重启已发生。`STAGED-CANDIDATE.json` 的 `deployed` 为 false。三台完整 SN 仍待用户指定，本文件不猜测名单。

Grok351 对 `262dfe9c` 的运行代码/回执隔离验收仍有效：本增量未改 rust-worker 与回执脚本，哈希与 Grok351 记录相同。本轮未重跑 cargo，未重编 release。

复核开始时本工作树 HEAD 等于 `d09b3cb6`。结束时 HEAD 为后续提交 `667d45077241f5945f5f99b3af3f7796acf1e237`（`fix(asr-ops): reject multiline env before targeted diagnostic edits`）。本结论不覆盖该后续提交，未 reset、未把它算作已验收。

## 固定 SHA 与六文件

开评时 `git rev-parse d09b3cb6` 得到完整 SHA `d09b3cb66df4ec99a6efcb0d8d2e93e6d6e5d0b1`。相对 `fab1dbd2599c311cc5ccaf371ed73890fad5dd26` 只有下列 6 个路径，+181/−1。

| 路径 | 本提交 SHA256 | 字节 |
|---|---|---|
| `2-Projects/realtime-voice-agent/scripts/asr_diagnostic_env.py` | `ec0020805ee923d434c6516dd41b260c8b0e3afaef03fd53de5be337c0ca3ee3` | 3460 |
| `2-Projects/realtime-voice-agent/tests/test_asr_diagnostic_env.py` | `d1364f2caa578cfb0686abcd202032e5d79c698c7484b2267ddbb63d0770da96` | 3197 |
| `docs/asr-three-device-20261116/CHECKPOINT-CURRENT.json` | `16c0730d575d8531d5000d20e2086457bb6639beccb4d32ad681087bc632fd03` | 3836 |
| `docs/asr-three-device-20261116/ROLLBACK_AND_RELEASE.md` | `a6db3417367bde1d1708a10f23622b47eab4b5ed0526a14c6f5e9518dc5a51ea` | 4455 |
| `docs/asr-three-device-20261116/STAGED-CANDIDATE.json` | `8b6eb87e3021882611e7dae43ec2b3be78fc847026c82a29a0ecaaee944c7840` | 582 |
| `docs/asr-three-device-20261116/STAGING_AND_ROLLBACK_TEST.json` | `fac33379210a9fa9355452c5c1374738ae5064c89364e746cd18bec3bdb883ab` | 318 |

仓库内两份 metadata 与 `/Users/fu-121/.local/state/p003-asr-three-device-20261116` 副本字节相同。本评审未输出 env 正文。

## 运行候选（未重做 Rust 全量）

| 项 | 值 |
|---|---|
| 运行源提交 | `262dfe9c0a7bc9c44769670e0312bcb66cb32671` |
| 二进制 SHA256 | `d37a39633ed8e7766e35744baf0b78ca2fbc12777a91b9a89f166029748c1c69` |
| 二进制字节 | 76399176 |
| 压缩包 SHA256（本地 `candidate.gz` 与 STAGED 相同） | `53db7d553046abf02973545e5b5fe2cdd461afbe7942d9ff6648a70cbd176f33` |
| 压缩字节 | 28513188 |
| 远端候选路径 | `/root/p003-asr-three-device-20261116/worker-candidate` |
| `deployed` | false |
| rust-worker 相对 `262dfe9c` | 无 diff |
| 回执脚本/测试相对 `262dfe9c` | 无 diff |

与 Grok351 `FINAL-REVIEW-GROK.json` 一致的内容哈希：`asr_diagnostics.rs` `8890d81429726a9fb412f9141442d58b272fb64fe6e9b1467118659ad7862ea1`，`pipeline.rs` `44961797abdc938350f449e8dd8d7e245ac064d4d1dabb90c41226028abf4c77`，`main.rs` `18a82bf6b453523bac0037f929e1784f1d87dca46bf68f0c40d17433e380f399`，`stt_volc.rs` `e877850ec6b3562098719f824aa75933a376dc9f5a38d868ddcbb5f468700a30`，回执脚本 `376c6bb43e273aadc8c55324a0e8a25b65e6c8b98ea84cab181a8a7a0ee6f0a6`，回执测试 `6b4118e8ec4d03e099ea88f81f2a283b5f924fe3e365eae5300c58533cb37fb4`。

## 主测 Python 29

隔离目录从 `git show d09b3cb6` 取出脚本与测试，不使用当时工作树后续版本。`python3 -m unittest test_asr_diagnostic_receipt test_asr_diagnostic_env`：Ran 29 tests，OK，0.029s。其中回执 19、配置 10。日志 SHA256 `d4bf3e1574360399f5dbc9e46546c7ce21c25ae446860d1cc6ebca1d729e665d`。

作者 `env-patch-green.log` SHA256 `9b8518bbf98d17b0602744c02c91ded03075b6643f9075ccae53af5f6ccc79e8`，与本提交 `STAGING_AND_ROLLBACK_TEST.json` 的 `log_sha256` 相同，内容为 `Ran 29 tests` / `OK`。`python_tests=29`、`exit_code=0`、`production_switched=false`、`three_sns_confirmed=false`、`runtime_source_unchanged=262dfe9c…`。作者红日志是配置测试在脚本尚未入树时的 `FileNotFoundError`；本评审只独立复现绿 29，未把红日志再跑一遍。

本增量没有把 `asr_diagnostic_env` 接到任何发布/锁/安装脚本。测试与文档是仅有的调用点。

## 独立反例（针对 d09b3cb6 blob）

合成 SN 仅用提交内测试夹具 `BJP0032611169999990{1,2,3}`，不当作真实设备名单。15 项独立用例 OK，0.017s，日志 SHA256 `25ba3c9a1423bd51f9e78ec64bf9fd7fae0486e78cf56897ae029823895e30e2`。

| 探针 | 结果 |
|---|---|
| 轮换 LLM/VENDOR 凭据并新增其他键后 restore | 凭据保持轮换后的值，诊断两键去掉 |
| 原文件中间已有两键，restore 只动这两键 | 字节回到原文件，OTHER/MID/TAIL 不动 |
| 向 state.before 注入无关键或跨键载荷 | ValueError |
| 诊断键重复（含一行 `export`） | ValueError duplicate |
| 诊断键跨行未闭合引号 | ValueError |
| 诊断键反斜杠续行 | ValueError |
| 非空且尾无换行 | ValueError newline |
| 已安装的 until 或 allow 被改、或删掉一键 | ValueError drift |
| 成功 restore 后再 restore | ValueError |
| 原行为 `export KEY=`，enable 写成无 export，restore 恢复原行 | 通过 |
| 空文件可 enable，restore 回到空 | 通过（局限：空内容绕过“必须有结尾换行”） |
| 格式合法的三台合成 SN 即可 enable | 通过（局限：不是白名单，更不是用户授权的三台） |
| 其他键跨行引号内出现诊断键名 | **d09 不拒绝**，会当诊断赋值改写 |
| 其他键 `\` 续行后下一行像诊断赋值 | **d09 不拒绝**，会当诊断赋值改写 |
| 源码无 `open`/`socket`/`subprocess`/`pathlib`/`systemctl` | 通过 |

## 远端取证（metadata 字节核同，未读 env 正文）

`STAGED-CANDIDATE.json`：候选在 `/root/p003-asr-three-device-20261116/worker-candidate`，28/28 分块，`deployed=false`，源提交 `262dfe9c`，二进制哈希与字节同上。

`CHECKPOINT-CURRENT.json`：`production_changed=false`。主池 PID 795375，运行/磁盘 SHA `d1b1d952c365f9648677ee88cd41ce96a42bc407fe47e2258b7e44875db581cf`，`backup_created=true`，两项诊断键为空。倾听池 PID 815868，运行/磁盘 SHA `c7e70e77e4600e09b02f885101a17e8e7cea0e9635bc430d456b88081b6289d5`，`backup_created=true`，两项诊断键非空（现役倾听诊断范围，不是待确认的三台发布名单）。搜索池 PID 815854，运行/磁盘 SHA `c7bec7df92c47136fd0c91e5c2b4ed59c918ffa7158cdfb3a63415fa1e221b25`，`backup_created=false`，两项诊断键为空。`WORKER-PREDEPLOY.json` 三池 PID 与 proc/disk SHA 与 checkpoint 一致。env 仅核 SHA/字节/mode，正文未读。

备份存在 ≠ 已对生产 env 调用 `restore()`，也 ≠ 已安装候选或重启。切换前仍须再核当前 proc/disk/配置。

## 通过边界

1. 本结论只覆盖 `d09b3cb6` 相对 `fab1dbd2` 的 6 文件，以及从该提交抽出的 Python 隔离测试。
2. 配置工具在“两键、单行、调用方负责写盘与重启”的前提下隔离通过。
3. 运行候选仍停在独立目录，SHA 与 Grok351 一致；本轮未宣称 Rust 新结论。
4. 文档与 metadata 写明未安装、未写诊断范围、未宣称生产/真机通过。该口径与取证字段一致。

## 阻断边界（不得据此切换生产）

1. 三台完整 SN 用户未指定。格式检查通过不是授权。严禁把测试夹具、倾听现役单台范围或任何台账猜测当成发布名单。
2. 候选未安装、未重启、`deployed=false`、`production_changed=false`。
3. 没有发布调用方实现锁、原子安装、当次备份、空闲检查、重启与安装后核验。纯函数通过不能代替这些步骤。
4. checkpoint 备份不能当作回滚已真实演练。搜索池没有发布备份。
5. 倾听池现役已有诊断两键。将来 `enable()` 会覆盖这两键原值；名单与窗口未确认前不得写。
6. `d09b3cb6` 对其他键跨行/续行不拒绝。现役 env 格式未经本评审核验（未读正文）。要把函数用于真实文件，须先人工确认全文件单行，或改用已拒绝任意键跨行的后续实现并另开复核。
7. 后续提交 `667d4507` 不在本次验收范围。

## 本评审未做

未改源码；未 checkout/reset；未 commit/push；未 SSH/写生产；未发送设备事件；未重跑 cargo/release；未打开 rust 二进制核对内嵌 SHA；未读取任何 env 正文；未指定三台 SN。
