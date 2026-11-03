# v376 钱包 known-zero 最小修复包

交付性质：**客户端源码补丁和隔离证据，未发布 Android 包、未改生产。** 安卓可在精确基线应用后完成集成，主13统一验收。不能直接把会话45整树部署到服务器。

## 固定锚与范围

- 客户端：`FUTURUS-ProductResearch/kidshub-ai---godot@3c653b5d3d28940fe6be275ba0382a6956d27234`。
- [补丁](v376-wallet-known-zero.patch) 改两个运行文件，新增一个测试文件。原始完整 Rust crate 与两份夹具共32文件均核 exact-ref Git blob，见 [CLIENT_CRATE_SOURCE.json](CLIENT_CRATE_SOURCE.json)。
- [PATCH_VERIFICATION.json](PATCH_VERIFICATION.json) 保存补丁SHA、三个文件前后SHA及实际应用/还原结果。应用后的字节与受测私有源码一致。
- 服务端隔离对象固定 `856552b942f5f8c2feb08db5949ebe7080eff77f`，Ark运行源码无修改；测试Node24.19.0。Rust实际使用1.97.1和已有离线缓存，不使用系统旧1.70工具链，不下载依赖。

## 实现及边界

| 输入/动作 | 修后行为 |
|---|---|
| schema2、来源normal/gm、完整合法稀疏wallet | 支持币种缺键投影为0，不往游戏钱包写入键；非零逐币种精确保留 |
| 缺formal/wallet/schema/来源，或钱包非法 | 不输出已知零；查询返回null或原有不可用错误 |
| 来源unknown | 钱包不作为已知值输出；云端继续保留unknown |
| 恢复默认化 | 在serde/default/normalize之前检查来源；缺损旧档标为已有字段unknown，避免后续存储/重启变normal0 |
| load返回None | 只有主、备、relaxed、临时文件均确定不存在才视作新档；损坏、不可读、残留或悬空符号链接保持unknown |
| 有效backup | 仍按现有加载顺序恢复真实余额；不把有效备份误判为新档 |
| 旧C-COIN-001别名 | 仅对已知来源/合法schema钱包沿用既有迁移，合并一次；查询不改原档，不重复加钱 |
| GM/清档 | GM重启仍GM；只有既有清档事务成功才normal0；写盘失败原资产/来源不变 |

不改奖励阈值、发奖结算、实际钱包金额、协议schema、设备归属epoch或任何云端开关。补勤卡库存仍沿用原投影，未知钱包不被云端强行填零。来源不明旧档不会仅靠打开页面、普通重启升级成可信资产；应由端侧另行取证修复，不能为了本次联调清除真实用户存档。

限制：若旧版早已默认化并把缺损档保存成完整normal档，原始来源证据已丢失，本补丁不能追溯识别。运行原生Rust用例不等于Android ABI/包体/Godot/Launcher或真人语音已验。

## 应用与复验

在安卓代码仓的独立开发分支、精确基线或已审查等价文件上执行；先保存当前改动，禁止强行覆盖有冲突的新版本：

```sh
git rev-parse HEAD
# 基线应为3c653b5d3d28940fe6be275ba0382a6956d27234；新基线需重审差异。
git apply --check /absolute/path/v376-wallet-known-zero.patch
git apply /absolute/path/v376-wallet-known-zero.patch
rustc --version
cargo test --offline --locked --manifest-path rust_runtime/Cargo.toml
```

项目Godot0.5.5要求Rust至少1.94；本次使用1.97.1。上述 `--offline --locked` 要求已有锁定依赖；缓存缺失时报告缺项，不默认更新Cargo.lock或升级依赖。

复验真实Rust投影：

```sh
wallet_evidence_dir=$(mktemp -d)
ARK_WALLET_FIXTURES_OUT="$wallet_evidence_dir/projections.json" \
  cargo test --offline --locked --manifest-path rust_runtime/Cargo.toml \
  export_real_projection_json_for_isolated_server_http
```

把本包 `rust-projection-http.test.ts` **原样复制**到固定856服务端的私有归档 `apps/server/scripts/audit45-v376-rust-projection.test.ts`，在该私有 `apps/server` 内执行：

```sh
ARK_WALLET_FIXTURES_IN=/absolute/path/projections.json \
  node --import tsx --test scripts/audit45-v376-rust-projection.test.ts
```

该测试只绑定127.0.0.1随机端口，用合成设备/本地JWT/临时SQLite，结束关闭服务、删除库。不访问生产、不调用外部模型。它从真实 `g1.ark.query` JSON读取钱包/来源/规则/逻辑日/进度，只添加合成传输信封；不重写语义字段。夹具逻辑日固定2026-11-02，今天的传输时间不能令旧进度变新鲜。钱包测试可用；当前暂停宝箱300秒另见父目录合同用例，不能冒充这份新档Rust夹具已产生该进度。

## 证据与回滚

结果见父目录 [TEST_RESULTS.json](../TEST_RESULTS.json)，日志在父目录 `evidence/`：原始164项基线、12项新增用例的RED、专项GREEN、最终完整回归、真实Rust JSON→HTTP。原脚本await语法失败已保留在 `wallet-http-harness-failed.log`；修正后的 `wallet-http-release.log` 为独立7/7，不把语法错误记作产品失败。

回滚源码前先 `git apply --reverse --check`，再反向应用本补丁；已独立核验还原后32原始文件hash一致且新测试文件移除。叠加其他开发后应针对revert，不能强制覆盖。回滚不撤用户资产或unknown标记，不改账号绑定。真实包回滚需安卓验证版本/签名规则，尚未声称验证通过。

安卓下一步：应用/复核补丁 → Godot/Launcher零与null透传 → 构建签名包并提供实际APK/PCK hash → 在获准设备白天真实对账。按 [ANDROID_HANDOFF.md](../ANDROID_HANDOFF.md) 收集同一snapshot/boot/seq/received_at/preview/语音证据；主13确认后收口。

署名：codex（OpenAI）| 2026-11-03
