# Task 2：条件解绑与 legacy 绑定代次保护

结论：实现完成，隔离真实 SQLite + 本机 HTTP 回归通过；未连接生产、未安装依赖、未提交/推送/部署。主线程可挂载 miniapp-admin router 并继续集成。

## 修改范围

- `apps/server/src/device-registry-store.ts`：新增 `unbindParent(sn, {publicId,parentAccountId,bindingVersion})`，`BEGIN IMMEDIATE` 内单条 `UPDATE ... WHERE sn/public_id/parent_account_id/binding_version RETURNING *`。命中才推进版本，重放/ABA/陈旧确认不写入；沿用现 Ark epoch 触发器。
- `apps/server/src/routes/admin-data.ts`：PATCH parent=null 强制 expected 三字段及可选 ≤200 字备注。缺/非法条件 `400 invalid_unbind_conditions`，条件变化 `409 binding_changed`，成功兼容旧 ok 字段并新增 `binding_version`。空字符串 parent 不能绕过 CAS。解绑日志包含管理员、SN、前后代次、时间、结果、备注，不自动附手机号、令牌或凭据。解绑后释放旧预授权/未 claim 会话；跨库清理失败只记日志，注册表事务和最终 claim CAS 始终兜底。正向非空绑定原逻辑保留。
- `apps/server/src/pairing-store.ts`：幂等增量迁移新增 `pairing_session.binding_parent_account_id`、`device_preauth.binding_version`、`device_preauth.binding_parent_account_id`。旧行保持 null，不补盖当前代次；新预授权只在创建时抓 owner/version。`invalidateBindingIntents(sn, throughVersion)` 仅释放旧代次意图，避免删除更新的意图。
- `apps/server/src/routes/pairing.ts`：扫码确认、预授权代确认、后台一键确认把创建时 owner/version 传入会话；自动确认、status、claim 拒绝旧 null-version 会话或已变更代次。claim 最终交给注册表条件事务；提交后签发/幂等恢复继续核 owner/version。保留旧 `sn_bound_by_other` 错误优先级。
- `apps/server/src/routes/profile.ts`：`performSnBinding` 和注册表 `bindParent` 新增可选 `BindingExpectation`（第四参数），普通 bind-sn 不传参数时行为兼容。成功结果新增 `bindingVersion`，由注册表绑定事务直接给出；claim 不再重新读取最新版本给旧会话盖章，修复提交后 A→null→A 的窗口。
- 后台 `manualConfirm` 新增可选 `bindImmediately=false`；admin 入口传 true，先条件关联再创建同代次会话，保留原来一键确认立即关联家长的行为，避免建会话后补关联导致自我版本冲突。直接 helper 调用仍在 claim 时绑定。
- 新 `scripts/miniapp-unbind.test.ts`；更新 `scripts/pairing.test.ts` 的三条既有滞后断言以匹配 HEAD 已有 status public_id/activation DTO 和始终启用的归属权限门。

未改 HTML、telemetry、miniapp-admin route、短信测试；这些文件的工作区变化属于其他任务。admin-data router 挂载由主线程负责。

## RED → GREEN 证据

日志目录：`/Users/fu-121/.local/state/p003-miniapp-admin-20261117/task2/`。

执行目录：`2-Projects/P003GameDemo20260513/apps/server`。

命令：`NODE_OPTIONS=--experimental-sqlite ./node_modules/.bin/tsx scripts/miniapp-unbind.test.ts`。

1. 首轮测试先于实现：`21 passed, 29 failed`，日志 `p003-unbind-red.log`。真实复现缺条件仍解绑、新家长被陈旧确认解绑、ABA、双请求两个200、旧预授权复绑、null-version 会话复绑、最终绑定缺 CAS 等问题。
2. 实现后发现提交后 ABA 额外窗口，先追加失败测试：`51 passed, 2 failed`，日志 `p003-unbind-aba-red.log`。双连接在注册表绑定成功、Brain 关联期间把 owner A→null→A，旧代码随后读最新 binding_version 竟签发成功并标 claimed。
3. 使用事务结果 `bindingVersion` 后，最终新测试 `70 passed, 0 failed`，日志 `p003-unbind-green.log`。

最终新测试使用真实 `@hono/node-server` 本机随机端口 + fetch、独立临时库和第二 SQLite 连接；不替换业务结果，只在两个真实调用边界插入可控的第二连接写入。覆盖：

- 读确认数据后取消无写；未鉴权401；缺/非法条件400；陈旧public_id、换绑、ABA409；双请求只一个200、只推进一次；重放409。
- 旧预授权被解绑清理；把旧预授权复制回库依然不能确认或 claim；历史 null-version 预授权失效。
- confirmed 但尚未 claim 的会话被清理；延迟写回旧会话仍409；历史 null-version 会话不能 claim 或重确认。
- 自动确认跨库竞态：preauth 校验后另一连接解绑，再落旧会话；最终 claim409、owner保持空。
- claim 前置检查通过后第二连接解绑：注册表事务 CAS409；绑定提交后 ABA 也不能把旧 claim 重盖为新版本。
- 正向预授权→announce→claim、后台一键确认立即关联→claim 正常。
- P256 BLE 真实 challenge→设备私钥签名→confirm→claim 正常；admin解绑后旧 BLE confirm/claim409，设备 BLE policy/key保留，legacy直接绑定/预授权继续受原 BLE guard 限制。
- 旧库新增字段后历史行保持 null；重复打开同库再次迁移不改历史行。
- Brain账号、public_id、档案、原始对话、真实入库业务流水、telemetry快照、原 Ark grant 逐行保留；旧父对话/Ark权限立即失效；重新绑定同一人不恢复旧授权。解绑代码不访问客户端未 ACK 队列，也不调用清库/删除/恢复出厂；客户端队列实际端到端验收由设备侧补充，不冒称本测试覆盖设备存储。

## 已执行回归

均使用 `NODE_OPTIONS=--experimental-sqlite ./node_modules/.bin/tsx scripts/<name>.test.ts`：

| 脚本 | 结果 |
|---|---|
| miniapp-unbind | 70 pass / 0 fail |
| pairing | 148 pass / 0 fail |
| device-session | 45 pass / 0 fail |
| device-registry | 28 pass / 0 fail |
| sms-auth（主线程更新后的合同） | 54 pass / 0 fail |
| mini008-dashboard | 16 pass / 0 fail |
| parent-conversations | 15 pass / 0 fail |
| ark-records | 32 pass / 0 fail |
| ark-records-legacy-http | 10 pass / 0 fail |

`git diff --check` 通过。

`npm test` 已尝试，server package 未定义统一 test 脚本，返回 Missing script: test，因此使用上述项目已有脚本逐项验证。

`./node_modules/.bin/tsc --noEmit` 仍有既有错误 `src/listening-content.ts(29,133): GeminiLlmClient 缺少 abort`；本任务修改文件无新增 TS 错误。主线程已有 HEAD 对照基线；本任务未修无关错误。

## 已知边界与集成提示

1. 旧 v1 bind_token 没有指定 SN 的创建快照，保持其原有正向兼容；本次保护 legacy v2/v3 预授权和已固定 SN 的会话。默认 v1 关闭；未暗中改变无版本 legacy 设备凭据兼容或全局撤销水位。
2. 历史 owner/version=null 的意图明确失效，用户需重新走确认。主线程只读生产快照反馈当前 active_preauth=0、pending_sessions=0；发布前仍需重核。
3. 旧 pairing 基线三个失败属断言滞后：rv-3f 忽略已有 public_id/activation 字段，rv-8b/8c 假定关闭展示开关可绕过当前源码早已常驻的归属门。本任务只校准测试，未为迁就断言放松权限。
4. 数据按现授权域失效；用时仍按 SN 汇总。没有声称解绑全量撤销旧 legacy 凭据，或跨家长彻底历史隔离。
5. 解绑 API 与两个 UI 入口须同步发布，旧缓存缺 expected 请求会400，需提示刷新重新确认。新增 router 挂载由主线程完成。

署名：codex（OpenAI）| 2026-11-17 08:10 CST
