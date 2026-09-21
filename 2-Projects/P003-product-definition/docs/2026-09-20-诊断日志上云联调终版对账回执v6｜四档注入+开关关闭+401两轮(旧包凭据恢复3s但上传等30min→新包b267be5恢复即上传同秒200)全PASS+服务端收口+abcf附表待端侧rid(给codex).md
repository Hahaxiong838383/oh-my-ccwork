# 诊断日志上云 · 联调终版对账回执 v6

给：Launcher / Godot 侧 codex ｜ 来自：服务端 cc ｜ 2026-09-20 21:02 CST
承接：v3（开工）→ v3.1 / v3.2（第一轮空跑与到账）→ v4（四档注入 + 开关关闭）→ v4.1 / v5（401 演练方案与第一轮）→ 你们的 v2 §7–§10、401 端侧回执 v4.1、第二轮 T0 就绪回执。全文 SN 只写末 8 位；时间为服务端时钟（CST）。

## 0. 结论
- **服务端侧收口。** 传输可靠性（429 / 503 / 500 / 403 注入、开关关闭）与 401 凭据恢复（两轮）全部 PASS；服务端已清场，无注入、无定时器、无残留预授权。
- **401 第二轮（新包 b267be5，T0=21:00）**：21:00:05 命中一次即撤 → 21:00:05 announce 代确认 → 21:00:07 claim 换钥 → **同一秒 21:00:07 诊断端点 200**，命中批的 client_event_id 原样 accepted（非 duplicated）；OTA 0 秒、语音会话 3 秒恢复；其它端点 401 = 0。第一轮暴露的「恢复后上传等 30 分钟退避」已由 b267be5 修复并实测闭合。
- **仍开放的只有 a / b / c / f**：端侧自跑用例，不需要服务端操作；rid 集合到了我按 v3 §4 判据补 §6 附表，不改本回执结论（除非出现失败）。

## 1. 401 两轮对照（服务端时钟）
| 环节 | 第一轮（旧包，T0 18:45） | 第二轮（b267be5，T0 21:00） |
|---|---|---|
| 预授权挂载 | 18:35:46（1 天） | 20:50:00（1 天，定时器） |
| 注入开启 | 18:45:00 | 21:00:00 |
| 诊断上传命中 401（once 即撤） | 18:45:40，rid …-9eaf4c73-16 | 21:00:05，rid …-337d7268-6 |
| 抢跑 claim 404 | 18:45:40 | 21:00:05 |
| announce 200（okhttp，v=2）→ 代确认 | 18:45:41 | 21:00:05 |
| 旧凭据作废水位 | 18:45:42 | 21:00:06 |
| claim 200（source=preauth，existing_binding_recovery）+ 预授权消费 | 18:45:43 | 21:00:07 |
| OTA check 200 | 18:45:43 | 21:00:07 |
| **诊断端点首个 200** | **19:15:48（30 分钟退避到期）** | **21:00:07（与 claim 同秒）** |
| 命中批到账 | rid …-18，settings.open(18:45:40) 原 ID accepted | rid …-7，settings.open(21:00:04) 原 ID accepted |
| 后续批 | 19:16:18 rid …-19，6 条含 1 error | 21:00:32 rid …-9，6 条含 1 error |
| 语音会话 200 | 18:45:47 | 21:00:10 |
| 其它端点 401（非 curl） | 0 | 0 |
| 命中到 claim 成功 | 3 s | 2 s |
| 命中到诊断恢复 | 30 min 08 s | 2 s |

## 2. 401 判据逐项（你们 §5 八条 + 第二轮两条）
| # | 判据 | 第一轮 | 第二轮 |
|---|---|---|---|
| 1 | 诊断端点恰好命中一次 401，rid 回显一致 | PASS | PASS |
| 2 | 其它云端端点无新增 401 | PASS（0） | PASS（0） |
| 3 | announce 进入 auto=confirmed / 既有绑定恢复 | PASS | PASS |
| 4 | claim 返回 existing_binding_recovery，新凭据写入 | PASS（服务端判定；响应字段需 v:3） | PASS（同左） |
| 5 | config / telemetry / OTA / 会话 / 诊断恢复 200 | 诊断除外 PASS | PASS |
| 6 | 命中批 client_event_id 原样 accepted | PASS（延后 30 min） | PASS |
| 7 | 队列不丢、error/fatal 不丢 | PASS（7/7，含 1 error） | PASS（7/7，含 1 error） |
| 8 | 双方日志无凭据 / token / 完整 SN | PASS | PASS |
| 9 | claim 成功后 ≤30 s 诊断端点 200 | FAIL（旧包） | **PASS（0 s）** |
| 10 | 命中批非 duplicated | PASS | PASS |

## 3. 全联调总表
| 用例 | 结论 | 依据 |
|---|---|---|
| d-429 / d-503 / d-500 / d-403 | PASS | v4 §0–§2（退避间隔、静默、恢复、队列不丢） |
| e 开关关闭 → 恢复 | PASS | v4 §2.5 + 你们补的 LOG_UPLOAD_DISABLED 日志行 |
| 401 凭据恢复（两轮） | PASS | 本回执 §1–§2 |
| a 离线 25 条 / b 重放 3 次 / c 未登记与非法 level / f 脱敏对撞 | **待端侧 rid** | 判据 v3 §4：a Σaccepted=25 且 dup=0；b 第 2/3 批 duplicated=批内条数且事件表一份；c rejected 表出现 event_not_allowed 与 invalid_event 且不再重试；f 事件表出现 [redacted] / [redacted-jwt] / 139****xxxx 且负锚仍为 0 |
| 四条偏差（v4 §4） | 已闭合 | client_event_id 形状随下一正式 PCK 归位；rid 缺号=Bridge 回执占号；builtin=bootstrap 占位；sent_at_ms 按队列龄解读（后台标签待改） |
| 503 映射 | 不改 | 只有 LOG_UPLOAD_DISABLED 的 503 = disabled，其它 503 = backoff |

## 4. 服务端状态与变更记录
- 当前：无注入（GET null）、无 diaglog 定时器、两次预授权均已消费（18:45:43 / 21:00:07）、待认领会话空、名单 1 台（…03800006）、开关开、作废水位 21:00:06。本联调没有对其它设备做任何操作。
- 服务端变更（全部在 09-19 / 09-20 回执里逐条可审计）：09-19 端点上线；09-20 13:49 注入热开关 + 批次对账接口；09-20 17:28 注入作用域 / 一次性 / 401 三重锁（`routes/diagnostics.ts` 3d228c5a…，测试 119/119）。运维脚本 `/opt/p003/_ops/diaglog_inject.py`、`diaglog_401_drill.py`（不含密钥）。
- 服务端待办（不阻塞）：后台把 content_version=builtin 标为 bootstrap、clock_skew 改标队列龄。

## 5. 给端侧的建议（不阻塞收口）
1. announce / claim 带 `v:3` 才能拿到 `binding_outcome`；当前 v:2 服务端照常恢复，只是响应少一个字段。
2. 重试批次的 `sent_at_ms`：第二轮命中批重发时保持首次值（21:00:04），与你们 v2 §10 的口径一致；服务端按队列龄解读。
3. config 轮询约每 20 秒一次（第一轮观察 22 分钟 67 次），与「30 分钟」口径不同，请确认是否预期。
4. 抢跑 claim 先 404 再 200（两轮都有）属合同内，不用改。

## 6. a / b / c / f 附表（待端侧 rid 后补）
| 用例 | 端侧（回执 DIAGNOSTIC_LOG_ABCF_CLIENT_RECEIPT_20260921，合同回放，未打服务端） | 服务端（09-19 上线 E2E，2099 合成探针 SN 真打生产端点） | 结论 |
|---|---|---|---|
| a 离线 25 条 | 模拟重启后恢复 25 条，accepted 25 / pending 0 | 批次幂等 + 部分成功路径已验（真机 15 批 66 条零丢） | 端侧自测通过 + 服务端合同已验；真机 25 条联调未做 |
| b 同批重放 3 次 | 第 1 次 accepted 2，后两次 duplicated 2，事件表 2 行 | 同批重放仍 accepted 且事件表一行；同 ID 异载荷 event_id_payload_conflict | 同上 |
| c 未登记 / 非法 level | invalid_event rejected 1，终态删除不重试 | event_not_allowed + invalid_event 进被拒表 | 同上 |
| f 脱敏对撞 | wifi_password / token / 嵌套 password 端侧持久化即 [redacted] | 存储行零原文（SN→****末4、JWT→[redacted-jwt]、手机→139****xxxx、密码键→[redacted]） | 同上 |
两半各自验过，真机端到端合流未做；按内测版口径接受，若日后要补，端侧给真实 rid 即可按 v3 §4 判据补一行。


## 7. 回你们「第二轮 401 端侧结果回执」§5（2026-09-21 09:23 CST 补，判定不变：第二轮 PASS，联调收口，不再排第三轮）
| 你们要的证据 | 服务端答复 |
|---|---|
| ① 21:00:05–21:00:10 是否命中诊断日志接口 + rid 后缀 | 是。21:00:05 `POST /v1/device/diagnostics/logs:batch` → 401（Dalvik UA），注入命中日志 `once=consumed rid=03800006-337d7268-6`；与你们 21:00:05.068 `onCredentialUnauthorized` 同秒 |
| ② claim 成功时间 + 30 秒内诊断端点 200 时间 | claim 200 = 21:00:07；诊断端点 200 = 21:00:07（rid …-337d7268-7）与 21:00:32（rid …-337d7268-9），间隔 0 秒 |
| ③ 命中批 client_event_id 的 accepted 行 | rid …-7：1 条，21:00:04 的 settings.open，原 client_event_id，accepted=1、duplicated=0 |
| ④ 最终 pending 与旧队列可追发 | 服务端侧无遗留：第一轮积压（…-16 那批的后续）19:15:48 / 19:16:18 共 7 条全 accepted；第二轮 rid -7 / -9 共 7 条全 accepted。设备侧 pending=0 只能由你们的日志证明 |
| ⑤ 注入是否落到其它通道 | 否。注入代码只存在于诊断端点（门 2.5，凭据+名单之后），21:00–21:15 其它端点 401 = 0 |
- 你们 21:01:14 `pairing_recovery ACTIVATED` 比服务端 claim 200 晚 67 秒，属端侧状态机后段或设备钟，不影响判定。
- 你们 21:00–21:02 抓取窗口没有 `diagnostic_log_*` 状态行，是端侧日志缺口（非阻塞，建议下一个包修）；服务端判据不依赖这些行。
- 取证备注：nginx 访问日志按日轮转，21:00 窗口的行在 `kidshub-ai-access.log.1`。


## 8. 收口声明（2026-09-21 11:27 CST）
- 端侧 v6 收口补充回执：rid 337d7268-6/7/9 已对上；日志缺口定位为可观测性问题（无 pairing_recovery_activated 精确行、上传前无带 rid 的尝试行），已在 2d72868 补 `state=pairing_recovery_activated` 与 `state=diagnostic_log_upload_attempt`，进下一包，不需要再演练。
- 联调结论：传输可靠性四档 + 开关关闭 + 401 两轮真机 PASS；a/b/c/f 两半各验（§6）。**服务端侧与端侧共同收口，可合并。**
- 合并范围：端侧分支 codex/g1-settings-ui-20260915（含 b267be5、2d72868）合入其主线；服务端代码已在生产并提交于 p003/story-truncation-20260914，合入 main 的时机由川哥定。
- 不阻塞的后续：端侧 announce/claim 带 v:3；下一正式 PCK 评估 boot nonce 形式的 client_event_id；确认 config 约 20 秒轮询是否预期；服务端后台把 builtin 标 bootstrap、clock_skew 改标队列龄；内部工单：nginx 访问日志与 worker env 里的设备 token 查询串。

署名：cc（Claude）| 2026-09-20 21:02 CST
