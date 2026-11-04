# v384 语音服务端修复与回滚

本轮只修两处：倾听态明确短退出口令；方舟静态用途短追问继承最近用户明确资源。未改Android协议、动态钱包投影、搜索任务流程、ASR词表、短信/自动登记入口。

## 固定输入
- Worker运行候选 `5b3fdaac2b0e6d552a899ea7a941616cfbed2d5d`，基线 `70d5f98a8f4d3e4aceca00890271a7bd7a1b6f3d`。
- 正式无测试feature二进制 SHA256 `7d39184c200053db5adbc59580517110762b0c3ac31928cc246d5f9162817de0`，77972432字节。
- RTC测试特性二进制 `270df2ab4944d0a4f7ff66a7a8f36a9c5ab6f418885d2edf921126f6c807a010`，禁止部署。
- Brain业务候选 `362b8db2ad529e21a4247a97ea3336a7300157de`，主树基线 `a9a6600446ab6a403eb7be8cc40b4fad79a0912c`。
- 倾听Brain保持实际c9c2aff9 custom-llm的R26/SSE取消/代理差异，只应用同目录patch；精确四文件见BRAIN_DEPLOY_MANIFEST.json，不能用主树整文件覆盖灰度。

## 回滚点
- Brain四文件：`/opt/p003/backups/v384-voice-brain-20261104/package.json`，含逐文件before/after SHA及原字节；本轮只重启p003-voice和p003-listening-brain。
- Worker：`/opt/p003-listening-canary-20261030/backups/v384-worker-20261104/`（已发布并验证），原正式二进制 `27a72325f781e37d1114f91b58feb53bfd38de4b1e6ec2ca6453a7745bcd5e86`、release.json。
- Worker能力manifest：Brain `/opt/p003/listening-canary-20261030/backups/v384-worker-manifest-20261104/`（已配对发布并验证）。
- 单机窗口前值：Brain与HK2各自倾听根的 `backups/v384-window-20261104/`，范围只有BJP00326070803800006；新截止2026-11-11 18:00 CST。旧截止已过，不应为了回滚源码自动恢复旧截止或关闭后又重开。

## 操作顺序
1. 先核实际运行SHA、health新鲜/registered/jobs=0、无活跃倾听租约；发现漂移停止覆盖，重新核对。
2. Worker与Brain能力manifest成对回退。Worker执行stop→本unit/cgroup与sidecar清零→恢复精确备份二进制及release.json→start；不得全机pkill、盲restart、替换正常池或旧搜索池。
3. Brain仅在当前after SHA仍等于本轮清单时恢复对应before字节，按实际变更的实例重启并核/health；不整树覆盖，不恢复数据库。保留新短信/自动首次登记/埋点/搜索差分。
4. 核真实管理接口runtime.ready与配置ACK、构建/manifest一致，检查热词/env/window及其他服务PID不变；观察至少3分钟无自动重启和panic。必须新唤醒取得当前来源代次的授权。
5. 配置回滚只恢复本次明确字段，禁止整库回灌。截止变更会推进sourceGeneration，旧grant不会重新有效；timer/state/manifest/main和canary独立数据库须同时核对。

测试日志与敏感原始证据在主机私有目录 `/Users/fu-121/.local/state/p003-v384-followup-20261104`，外发回执不包含用户原始正文、设备Bearer或后台凭据。

## 延窗服务凭证修正

本次发现旧Worker服务JWT在原窗口17:58:31到期，虽然延窗配置已更新，实际管理ready仍为false。按既有服务账户和scope合法续期至2026-11-11 18:00 CST，并按空闲门stop/清场/start；真实管理HTTP的ACK重新推进。此为Worker服务凭证，不是设备Bearer。

凭证前值仅在HK2 `/opt/p003-listening-canary-20261030/backups/v384-service-credential-20261104/canary.env.before`（私有）保存。新env SHA256 `ae4a509dc062553d2a83557673bdba0dc24fb6e3cfa0e45200c85a7dc2784211`。**代码回滚不得整份恢复该旧env，否则重新加载已过期服务凭证。** 保留续期后的env，核实际进程JWT截止及真实管理ready；不在日志或仓库放token。

## 本轮经验

- 同一问题可被ASR/判停切成两个用户轮，静态知识要有限承接最近明确对象；动态库存仍只取可信当前数据。
- 倾听态退出同义句要贯穿candidate/final/text门，且保留原proposal/ACK链；普通模式不扩大短口令影响。
- 延窗必须一起核数据库、独立Brain库、manifest、Worker窗口、timer/state、实际服务凭证有效期和配置ACK；仅看health不足。
- 现役灰度源码与主树可能有R26/代理差异，按逐文件差分精确发布；测试特性二进制和正式产物分别固定SHA。
- 软件探针前置失败、ASR错误、服务端解析失败和真机消费失败分别留证，不能用最终一条绿灯覆盖首次失败。

源码回滚标签已推送：`rollback/p003-v384-brain-pre-20261104` → `a9a6600446ab6a403eb7be8cc40b4fad79a0912c`；`rollback/p003-v384-worker-pre-20261104` → `70d5f98a8f4d3e4aceca00890271a7bd7a1b6f3d`。Brain源码标签不替代现役灰度逐文件备份。

主13已独立回读服务端备份：四文件before/after字节与SHA、当前after、旧正式Worker二进制/构建、旧配对manifest均核同。见reviews/verify-backups-{brain,worker}.json；只验证备份完整性，未在生产执行恢复演练。
