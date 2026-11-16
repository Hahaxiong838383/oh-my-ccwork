# 五机 ASR 发布调用方审查

审查对象是固定提交 `579e8a15e28c83a8c68af54103a44b7df1df7195` 里的发布脚本，用 `git cat-file` 归档，不读变动中的工作区副本。归档在 `/Users/fu-121/.local/state/p003-asr-three-device-20261116/archive-579e8a15/`。

- 发布脚本 SHA256 `fc8a60e273caf9acd67d04a2b14eb2fbdbf8d70c25d5744c9bd31fe5fc744c15`（9840 字节，143 行）
- 配置工具 SHA256 `46498b02a81fce1f22929c7ff14b04cc209034b84db2cec753b558b26e564888`（3745 字节）
- 私有 `SPEC-CANDIDATE.json` 与 `STAGED-DEPLOY-TOOLS.json` 的 helper/deployer 哈希与上述 blob 相同
- `SPEC.reviewed` 仍是 `false`
- 审查结束时工作区 HEAD 是 `d53dd824497fada79e3cf151b0134c0b18458d45`。该提交改了同一发布脚本。本裁决不覆盖它。当前 SPEC 仍钉住本 blob，直接换 HEAD 脚本会在部署器自校验处拒绝

未操作生产，未重启服务，未改仓库源码，未 commit/push。运行候选 `262dfe9c0a7bc9c44769670e0312bcb66cb32671` 与二进制 `d37a39633ed8e7766e35744baf0b78ca2fbc12777a91b9a89f166029748c1c69` 沿用既有验收，本轮没有重跑 Rust，也没有再访问设备或房间接口。

署名：grok（xAI）｜2026-11-16

## 结论

**阻断。** 不能把这份已 stage 的 `deploy_asr_diagnostics.py` 当成可无人值守回滚的发布器去执行 apply。

check、正向 apply、凭据保留、五机数量、空房拒绝、注册成功路径都通过。阻断在失败恢复：显式 rollback 一旦在写回文件之后启动失败，就不能再进入；apply 的失败回滚若在恢复中途遇到二进制断言，会留下已写入的诊断 env 并停在 inactive。

## 阻断

### 1. 显式 rollback 写回文件后启动失败，不可重入

`deploy_asr_diagnostics.py` 第 91–101 行。rollback 先 `stop()`，再写回旧二进制、两键恢复后的 env、主池元数据，然后才 `start(before_binary)`。这段没有 try/except。`start()` 在第 90 行抛出 `RuntimeError: worker failed registration/health` 时：

- 磁盘已经是回滚后的旧二进制，诊断两键已经从 env 去掉
- `ROLLBACK-<pool>.json` 还没写
- 原 `RELEASE-<pool>.json` 仍是 `success: true`
- 再次执行 rollback 在第 47 行要求磁盘和 `/proc/<pid>/exe` 仍等于候选 SHA，于是 `AssertionError: runtime binary drift`

隔离模拟复现：第一次 rollback 退出码 1，服务记录仍是 `ActiveState=active` 且 PID 已换成启动出来的进程，但日志没有 `registered worker`。第二次 rollback 退出码 1，错误是 `runtime binary drift`。env 保持第一次已写回的内容，没有再次被改。

这表示注册抖动或健康文件晚到时，池会停在“文件已回滚、脚本报失败、不能再跑 rollback”。apply 失败后的补偿启动如果成功，不受这一条影响；受影响的是用户已授权的独立 rollback。

### 2. apply 失败回滚里的断言会跳过 env 恢复和重启

第 130–138 行。`binary_written` 之后如果磁盘 SHA 不再等于候选，第 135 行 `assert sha(binary)==after_binary` 直接中断。后面的 env 恢复、元数据恢复和 `start(before_binary)` 都不执行。

隔离模拟在 `systemctl start` 期间把磁盘二进制改成其他字节，并让第一次注册失败。结果：退出码 1，receipt 的 `error_type` 是 `RuntimeError`，`rolled_back` 没有写成 true，env 里仍有 `P003_ASR_DIAGNOSTICS_SN_ALLOW`，单元停在 `inactive`。最后冒出的异常是 `AssertionError: binary drift during rollback`。

env 配置锁挡的是另一份这份脚本，挡不住启动窗口里对二进制的其他写入。恢复路径用断言当控制流，池会带着新的诊断 env 停住。

## 通过

| 项 | 结果 |
|---|---|
| 五机数量 | `enable()` 第 53–55 行要求恰好 5 个、互异、匹配 `BJP003` 加 14 位数字。归档测试 `Ran 13 tests` / `OK`（0.012s）。另测 4 台、6 台、5 台重复都拒绝；用户这 5 个 SN 往返后凭据字节不变 |
| 名单与台账 | `USER-SCOPE.json`、`FIVE-DEVICE-REGISTRY.json` 的全部 `active`、`SPEC-CANDIDATE.json` 的 `device_sns` 集合相同。截止相对台账 `at_ms` 约 7.00 天 |
| reviewed 门 | 第 108 行 `spec['reviewed'] is True` 只在 check 返回之后。`reviewed=false` 时 check 退出码 0，apply 在创建备份前拒绝，env 字节不变 |
| check 不是 apply | check 不调用 stop/start，不写 `release-before-*`。提交里的 `PRECHECK-MAIN.json` / `PRECHECK-LISTENING.json` 只有 `precheck/idle/device_count=5/no_runtime_mutation` |
| 锁 | 第 37–38 行对 `<env>.config.lock` 做 `LOCK_EX\|LOCK_NB`。重叠的第二次 check 得到 `BlockingIOError`。主机名不匹配时在开锁之前退出 |
| CAS / 防并发漂移 | env、unit、磁盘/proc 二进制任一 SHA 不符，check 在写入前拒绝。搜索池 `NRestarts` 在 stop 前变化时，apply 退出且不调用 stop，主池二进制和 env 保持原字节 |
| 逐池备份 | apply 在切换前写入本池 `binary`、`env`、`diagnostic-values.json`；主池另备份 `metadata`。倾听不写 `stop-variants-release.json`，也不换二进制 |
| 凭据保留 | 正向 rollback 前把 `LLM_KEY` 从合成值改成另一合成值。回滚后该值还在，诊断键按备份去掉，主池元数据回到原字节。receipt 正文不含合成凭据。倾听回滚恢复原来的单 SN 与原截止，二进制字节不变 |
| 真实空房 | 非空 `rooms` 列表使 check 以 `active room` 拒绝，不写备份。控制接口抛错也拒绝。check 使用进程里的 LiveKit 凭据调用 `ListRooms`，不调用 `DeleteRoom` |
| 注册与 proc | 正向 apply 要求新 PID 的 exe SHA、磁盘 SHA、日志中的 `registered worker`、两个诊断键，以及前缀范围内的旧进程环境值。倾听还要求健康文件在本次启动之后更新。注册失败且补偿启动成功时，env/二进制/元数据回到原字节，服务回到 active，receipt 为 `success false` 且 `rolled_back true` |
| 其他池 | 正向主池 apply/rollback 没有对 `p003-search-worker` 调用 stop/start。搜索二进制字节不变。只删除本池 `EOT_SOCK`；倾听的套接字还在 |
| 倾听二进制 | 倾听 `after_binary` 等于现役 SHA。`261475bf` 与候选 `262dfe9c` 的 `enabled_for` 函数体无差异，逗号分隔名单由现役倾听二进制解析。本轮没有重编译 |

## 非阻断残留

- `ListRooms` 返回 `{"rooms": null}` 或缺 `rooms` 键时，check 当成空房并退出码 0。非空列表和接口异常会拒绝。现役预检走的是真实列表；这只说明异常 JSON 形状会放过。
- 脚本不打开 `FIVE-DEVICE-REGISTRY.json`。另一组格式合法的 5 个 SN 也能通过 check。当前 SPEC 与台账集合一致，所以这一次发布输入是这 5 台。
- 第 33–36 行先 `exec_module` 再核对 helper SHA。篡改过的 helper 会先执行顶层代码，然后断言失败，env 不改。钉住的 helper 顶层没有副作用。
- `os.umask(0o077)` 之后，请求模式 `0o755` 的二进制实际是 `0o700`。属主仍可执行。隔离模拟测到 `mode=0o700`。现役原模式是 `0o755`。同仓库搜索单元模板没有 `User=`。本评审没有现役主 unit 正文。
- rollback 成功回执里的 `other_settings_preserved` 是常量 `true`。文件层恢复有测量，进程环境没有在 rollback 路径再读一遍。
- 安全条件写在 `assert` 上。`python -O` 或 `PYTHONOPTIMIZE=1` 会去掉这些门。已发生的预检能通过，说明当时的解释器执行了断言。
- 两池各有自己的 env 锁。并发对两池 apply 靠 “其他单元 PID/NRestarts 变化” 失败关闭，不是一把全局锁。发布顺序仍应先主池后倾听。
- 成功或失败后 `release-before-<pool>` 与 `RELEASE-<pool>.json` 留在目录里。第 109 行拒绝覆盖。第一次发布不受影响。
- `atomic()` 同步文件内容，不同步父目录。临时文件名冲突时 `O_EXCL` 失败并拒绝覆盖目标文件。

## 隔离模拟

模拟只改私有副本里的路径、`time.sleep` 和伪造的 `hostname`/`systemctl`/`journalctl`/`ListRooms`。没有调用真实 systemctl，没有连接生产。30 项预期全部出现，意外失败 0。其中两项阻断用例是故意让启动失败或在启动时改掉二进制，用来证明恢复路径的缺口，不是正向发布失败。

合成凭据只存在于模拟 env。没有读取或输出生产 env 正文。

## 尚未越过的边界

- 没有在 `voice-worker-hk2` 上执行 apply 或 rollback，没有真实重启，没有真机对话。
- 主 13 已做的 main/listening check 仍只是预检。`SPEC.reviewed=false`，本文件不把它改成 true。
- HEAD `d53dd824497fada79e3cf151b0134c0b18458d45` 未审。SPEC 钉住的仍是本 blob。
