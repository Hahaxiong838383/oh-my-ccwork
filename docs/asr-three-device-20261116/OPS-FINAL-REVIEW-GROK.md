# 667 多行环境误改复验

审查对象：固定提交 `667d45077241f5945f5f99b3af3f7796acf1e237`。父提交 `d09b3cb66df4ec99a6efcb0d8d2e93e6d6e5d0b1`。材料来自 `git show` 归档 `/tmp/grok-667-review-89746`，没有把工作区文件当作候选。

署名：grok（xAI）| 2026-11-16

## 索引

- 结论：`isolation_pass`。阻断：无。
- 范围：这 5 个路径相对 d09 的纯函数修复，加 32 项 Python 回归和独立多行反例。
- 红：d09 对下方两个输入会改写别的键。绿：667 对这两个输入抛 `ValueError`，没有返回新字节。
- Python：归档上 13 + 19 = 32，0 失败。解释器 Python 3.12.2。
- 停在这里：纯函数内存结果。不是安装、锁、空闲、原子替换或服务回滚。现役 env 本轮没有重读。Rust 与已暂存二进制没有重跑。三台完整 SN 仍待用户点名。
- 测试时 HEAD 是 667，候选取自该 SHA 的归档。报告落盘时 HEAD 已是子提交 `579e8a15e28c83a8c68af54103a44b7df1df7195`。该提交不在本结论里。
- 未 commit，未 push，未做生产或网络操作。

## 结论

667 关掉了 d09 的误改：别的键的多行引号或反斜杠续行里出现诊断键时，逐行正则会把那一行当成诊断赋值并替换。667 对每条非空、非注释行先做 `shlex.split`，行尾反斜杠直接拒绝；注释行里的引号不参与。替换行还必须以换行结束。

这只证明归档里的纯函数在隔离输入上拒绝这类文件，并在单行输入上内存往返。`enable()` / `restore()` 只返回字节。调用方仍要自己做锁、当次备份、空闲检查、原子安装和重启。32 项通过不能写成真实回滚已经做成。

## 固定 SHA 与五文件

父提交就是 d09。`git diff --name-status d09 667` 只有这 5 个路径，+30/−10。归档字节与 `667:path` 的 blob 一致。

| 路径 | 内容 SHA256 | git blob |
|---|---|---|
| `2-Projects/realtime-voice-agent/scripts/asr_diagnostic_env.py` | `5de7407926551f09362bff966740471df5ac2953df8db3531a9011816a9b004d` | `07a93e87` |
| `2-Projects/realtime-voice-agent/tests/test_asr_diagnostic_env.py` | `868a69c0c31756ea29eb37fbc8af34fcd87606f54360b2419b28962b9d8af4d0` | `5e02574f` |
| `docs/asr-three-device-20261116/ENV-COMPAT-CURRENT.json` | `6def510c42961ff09346a8bb8061ccc6baabcbf51ff9058ad84bb24d20a0819c` | `c188a2be` |
| `docs/asr-three-device-20261116/ROLLBACK_AND_RELEASE.md` | `8b0f5e6f73ca45fcefbd1f132ab8ffc34780cdb322465b4594edece0836263ea` | `849176bb` |
| `docs/asr-three-device-20261116/STAGING_AND_ROLLBACK_TEST.json` | `c24d6f39ef31694142d92bb325953223d9889c68c50334af66d9c6a204b8b2bb` | `d42aa527` |

回执脚本 `asr_diagnostic_receipt.py` 的 blob 在 d09 与 667 都是 `fc85212aaefea9ed11acd594c103a6b4c34e3d69`。它不在这 5 个路径里，只为跑满 19 项回执回归而从同一 SHA 取出。模块 AST 里没有 `open`、路径写入、子进程或套接字。

## 可复现红例

诊断键为 `P003_ASR_DIAGNOSTICS_SN_ALLOW`。合成 SN 为 `BJP00326111699999901/02/03`，`until_ms=2000`，`now_ms=1000`。d09 模块与 667 的新测试放在一起时，13 项里只有下面两项失败，失败原因都是 `ValueError not raised`。

双引号跨行：

```
OTHER="first
P003_ASR_DIAGNOSTICS_SN_ALLOW=inside-other-value
last"
```

d09 的返回值把中间行换成诊断赋值，引号被拆开，并在末尾追加截止时间：

```
OTHER="first
P003_ASR_DIAGNOSTICS_SN_ALLOW=BJP00326111699999901,BJP00326111699999902,BJP00326111699999903
last"
P003_ASR_DIAGNOSTICS_UNTIL_MS=2000
```

667 抛 `ValueError: No closing quotation`，没有返回值。单引号跨行、引号内缩进的诊断键、引号中间的空行，d09 同样改写中间行；667 同样拒绝。

反斜杠续行的原文是 `OTHER=first\` 紧接换行，下一行是 `P003_ASR_DIAGNOSTICS_SN_ALLOW=continuation`。d09 替换第二行并追加 `P003_ASR_DIAGNOSTICS_UNTIL_MS=2000`，第一行的续行反斜杠还在。667 抛 `ValueError: continued environment assignment`。CRLF 续行和 `export OTHER=first\` 再换行，同样是 d09 改写、667 拒绝。

## 独立反例

| 输入 | 667 |
|---|---|
| `# author's comment "not a value` 下一行 `OTHER=yes` | 接受，restore 后逐字节等于原文 |
| `;` 注释、缩进 `#` 注释，注释内有未闭合引号 | 同上 |
| `# keep \` 下一行是旧诊断键 | 接受；注释原样保留，只替换真正的诊断行；restore 逐字节相等 |
| 同一行 `OTHER="P003_ASR_DIAGNOSTICS_SN_ALLOW=inside"` | 接受；该行原样保留，诊断键追加在末尾；restore 逐字节相等 |
| `OTHER=first\` 加空格再换行，下一行才是诊断键 | 接受。systemd 把这个反斜杠当成转义空格，下一行是独立赋值 |
| `OTHER=value\\` 行尾两个反斜杠 | 拒绝，`continued environment assignment`。这是宁可拒绝。systemd 会把它当成值以一个反斜杠结束的完整单行 |
| `OTHER=\xff` | `UnicodeDecodeError`。函数仍不返回新内容。d09 会原样留下这个字节 |
| `replace()` 收到没有末尾换行的诊断行 | `ValueError: invalid diagnostic assignment` |
| `# retained` / `LLM_KEY=example-only` / `OTHER=unchanged` | restore 逐字节等于原文 |

当前 systemd `env-file.c` 在单引号或双引号内部把原始换行算进值，反斜杠加换行才是续行。667 用逐行 `shlex` 加行尾反斜杠覆盖这两种形状。注释行末的反斜杠被跳过，下一行仍按独立行处理；这与 systemd v254 之后的注释规则一致。

## 32 项回归

在归档目录执行，加载路径都在 `/tmp/grok-667-review-89746/667` 下。

- 第一次 `discover test_asr_diagnostic_*.py`：`Ran 32 tests in 0.033s`，`OK`。
- 分开再跑：环境 13 项 `0.008s OK`，回执 19 项 `0.020s OK`。
- d09 脚本配上 667 的环境测试：`Ran 13 tests`，失败 2，错误 0。失败名是 `test_foreign_multiline_cannot_be_mistaken_for_target` 和 `test_foreign_continuation_is_refused`。

提交里的 `python_tests: 32` 与这次计数一致。提交里的 `log_sha256` 没有按对方的日志字节重算。

## 本结论停在这里

- 现役文件不在这台机器上：`/root/rust-worker/rust-worker.env` 与 `/opt/p003-listening-canary-20261030/canary.env` 都不存在。本轮没有 SSH，没有重放 `env-compat-current.py`。`ENV-COMPAT-CURRENT.json` 里的 SHA256 与 `CHECKPOINT-CURRENT.json` 的记录相同：main `195c004bd0b68dca5ee63d2231b817d1af6b2b7be8d27dd23b618b1ebd599989`（12817 字节），listening `0eb30628f1e1a4a187effb1c43aded65ee42e92c02f660b7a1cbe805e7541d02`（11743 字节）。这只对照了两份元数据，不是本轮重新读到的文件字节，也不是本轮做的内存往返。
- Rust 提交 `262dfe9c0a7bc9c44769670e0312bcb66cb32671` 在库里是 commit。五文件差异里没有 Rust，也没有候选二进制。本轮没有跑 Rust，没有重哈希 `d37a39633ed8e7766e35744baf0b78ca2fbc12777a91b9a89f166029748c1c69`。
- 测试 SN 是合成号。`STAGING_AND_ROLLBACK_TEST.json` 里 `three_sns_confirmed` 为 false，`production_switched` 为 false。
- 跑测试时 HEAD 是 667，工作区当时开始出现未提交编辑。报告落盘时那些编辑已经变成 667 的子提交 `579e8a15e28c83a8c68af54103a44b7df1df7195`（`ops(asr): prepare authorized five-device release with idle and drift guards`，2026-11-16 19:01:05 +0800），工作区干净。相对 667 它改了环境脚本、环境测试、`PLAN.md`、`ROLLBACK_AND_RELEASE.md`，并新增 `deploy_asr_diagnostics.py`、`USER-SCOPE.json`、`FIVE-DEVICE-REGISTRY.json`、`FIVE-SCOPE-TEST.json`、`PRECHECK-LISTENING.json`、`PRECHECK-MAIN.json`。本结论没有读、没有跑这个提交。
- d09 的大范围审计仍归 Grok353。d09 通过不能写成 667 通过；667 通过也不能回头写成 d09 通过。
