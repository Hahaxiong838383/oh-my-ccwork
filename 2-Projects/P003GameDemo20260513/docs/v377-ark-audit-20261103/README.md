# v377 钱包补丁适用性与 Ark 联调审计（会话45）

结论：**现有钱包补丁可以干净应用到精确v377并完整还原；v377本身没有合入修复。Ark服务端授权可联调，真实normal包与问答仍未验。**

## 固定源与实际验证

- 原45分支：`codex/p003-ark-brain-context-20261031`；本阶段起点 `724559e5a30d8a6a42755189dd7b78b73e982080`。只新增本目录审计材料，没有另造实现。
- 客户端源码：`35502e7746eed6b5f24e5ba1cfa7d7e263c68a72`；该commit根tree `6cbabe72c768bbc72e93c8c3102fa03295838283`。
- [CLIENT_SOURCE.json](CLIENT_SOURCE.json)：38份文件逐项核exact tree blob/SHA，包含完整Rust crate及两份夹具32文件。对照v376的9份Rust/Godot/Launcher运行文件完全相同；2个提交17文件差异见 [SOURCE_DIFF.json](SOURCE_DIFF.json)，没有钱包修复。
- 复用已交 [v376-wallet-known-zero.patch](../v376-ark-audit-20261103/client-fix/v376-wallet-known-zero.patch)，SHA256 `131d91ddd04482e9bad4d9234b424fa2af81c7224134eb6935b8b6cd336465ab`。该补丁已包含在提交724559e5；本轮未修改补丁。
- 在独立私有副本执行 `git apply --check` → `git apply` → 比较修后字节 → `git apply --reverse --check` → `git apply --reverse`。四条命令exit=0，无stderr；38份原始文件内容及文件集合全部还原，新测试文件移除。见 [PATCH_APPLY_REVERSE.json](PATCH_APPLY_REVERSE.json)。
- 应用后的完整Rust crate/测试/夹具共33份文件与已测试候选逐字节相同，复用此前原生Rust176/176、真实Rust投影HTTP7/7证据：[既有测试结果](../v376-ark-audit-20261103/TEST_RESULTS.json)。**本阶段没有重跑测试，不把源码字节等价当Android集成/包体验证。**

## 服务器读回与阻断

12:30:52 CST独立只读核：cfg-66、新诊断请求仍有效至23:29:59.775，正常日批23点；Ark master=true/revision3，身份与grant epoch3、账号匹配，not_before仍为1793609324433。12:30:46最新真实快照仍GM（钱包1项null），没有取得normal验收样本。见 [READBACK.json](READBACK.json)。

可外发最小回执：[ARK_RECEIPT.md](ARK_RECEIPT.md)，包含授权水位、版本阻断和同一快照对账字段。v377只新增日志导出相关能力不能代表钱包修复已入包；它可以继续验证传输、日志及未知值诚实回复，不能验收known-zero修复。

当前GM来源不能靠重启、退出页面或改标签认定normal。在保留存档约束下拿不到可信normal时，这一项保持待验，不清档、不人工补余额、不在云端null→0。安卓需先交包含修复的新源码锚、APK/PCK实际hash及安装证据，再做同snapshot/boot/seq/captured/received/preview/真人问答对账。Ark授权没有随本次Analytics窗口自动到期的承诺。

## 对外草稿复核与变更边界

已读主13的开窗回执草稿，仅复核45负责的Ark授权、源码差异与对账边界：未发现与证据冲突的事实。建议第4步显式写明“若保留GM存档暂不可取得可信normal样本，则该项待验”；主13决定是否调整，45未修改公共回执。草稿hash和复核时点见RESULTS.json。

本轮无生产/设备/安卓共享分支变更、无POST探针、无语音触发、无故障注入。所有提交仅审计文档和脱敏证据；没有凭据、完整SN、真实对话或私有运维脚本。撤销本阶段文档可针对本次文档提交revert；客户端源码回滚方式仍见既有补丁说明，未验证Android降级安装。

署名：codex（OpenAI）| 2026-11-03
