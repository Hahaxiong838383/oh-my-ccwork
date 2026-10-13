# P003 埋点服务端部署回执

**结果：服务器与后台已完成关闭状态部署；集中上传容量未通过，暂不放行任何设备采集。**

部署完成：2026-10-13 11:53:47 CST；公网/API验收11:54，后台真实浏览器验收11:55，备份与异机拉取验收11:56。用户已授权开发部署及回滚准备。本回执不代表端侧真机、夜间上传或灰度验收通过。

## 已交付与当前状态

| 项目 | 结果 |
|---|---|
| 上传入口 | `POST https://kidshub-ai.hahaxiong.cc/v1/device/analytics/events:batch` |
| 后台入口 | 原公司后台 `/admin/` → Worker管理 → 数据埋点，仅admin可读 |
| 后台内容 | 概览、上传批次、事件对账、57事件目录、采集配置；配置页只读 |
| 设备配置 | 完整快照保schema_version/revision/posture，新增analytics；当前全局false/0点，revision=`cfg-11`（验收时快照） |
| 三重开关 | 全局上传false、独立埋点灰度名单0、服务器总闸false；所有上传保持关闭 |
| 生产数据 | events=0、seen=0、batches=0；关闭状态请求未增加数据 |
| 公司后台 | 3001，仅必要重启1次，验收PID2817417、restart计数22→23、online |
| 个人服务 | 3002未修改或重启，PID1626403/restart0保持 |
| 独立采集进程 | `p003-analytics`，仅回环3006，验收PID2817362/restart0、online |
| 维护 | 汇总timer每5分钟；备份timer北京时间00:30；首次实际运行成功 |
| 异机副本 | Studio私有目录，实际LaunchAgent拉取成功并校验SHA/完整性；每天00:45及每小时补拉，保留7天 |

PID、revision和下次任务时间仅是验收时状态，之后应现查；不得作为永久常量。

服务端复用已有设备Bearer和原admin权限，无新APK/设备凭据发布，无OTA、设备唤醒或HK2 worker操作。个人站及原语音运行时不升级。

## 可复核的发布锚

- 源码分支：`codex/p003-analytics-20261013`；生产源码提交 `e0585c1edcda38245467fb160b034b63e77dfa79`。
- 完整发布包67文件，288618字节；SHA256 `7bff024166b919bb7c67c81083651ebe03ffa0a33e7dd62c9a3233047a61f43a`。
- HK逐文件清单：`/opt/p003/server/backups/analytics-releases/analytics-release-20261013/manifest.json`；部署后67个实际文件均复核SHA一致。后续文档提交不冒充生产运行代码重新部署。
- PM2 CLI配置入口 `deploy/analytics.config.cjs`，共用定义 `deploy/analytics.ecosystem.cjs`，应用入口 `deploy/analytics-start.ts`；专用Node24.19.0/SQLite3.53.3；系统Node和原语音运行时保留。
- SQLite运行态实测FULL=2、wal_autocheckpoint=0；独立checkpoint缺省10秒、30秒deadline、60秒过期判断；WAL准入硬闸256MiB；提交后才返回accepted，seen与稳定HMAC不清、不轮换。
- ingress写页缓存64MiB；备份新隔离目标完整性检查临时页缓存128MiB。健康接口中的RSS/WAL/汇总水位是实值，不用假数据装饰生产看板。

两个PM2启动集成问题均在公司进程重启前被启动闸拦下：实际PM2不识别原`.ecosystem.cjs`文件名为配置，修为`.config.cjs`别名；PM2的argv[1]实为ProcessContainerFork.js，原CLI main判断不触发，修为显式bootstrap入口。现场RED/GREEN回执保留。另一次发布包元数据名称预检失败发生在写源码前，修正为工具要求的release.json后67文件预检通过。未把这些失败写成成功，也未通过重复重启原公司/个人服务排查。

## 实际验收结果

| 验收 | 实际结果 |
|---|---|
| 公网鉴权与权限 | admin的7类GET均200；editor/guest各7类均403；未登录401 |
| 完整设备配置 | 既有Device Bearer只读GET200，posture/revision保留，analytics=false/0；未发送applied_revision、未发布设备动作 |
| 关闭上传 | 既有有效设备凭据POST返回JSON503、ANALYTICS_UPLOAD_DISABLED、Retry-After=900；前后事件/seen/批次均0 |
| 入口错误 | 无效凭据401；Nginx超过3MiB返回JSON413；应用2MiB限制另在隔离环境验证 |
| 真实前端 | 正式HTTPS后台WebKit/Vue/Element Plus正常挂载；8次新增GET200、57注册表/Schema、关闭状态0数据及只读配置正确，page errors=0 |
| 原3001健康 | 40次HTTP探针P95=4.168ms，前基线1.051ms，增量3.117ms≤50；这是HTTP健康探针，不是语音听感或逐轮回复验收 |
| 隔离功能 | 假凭据/假SN/独立端口和库，13组smoke通过；含57源码推导样例、混合拒收、3次重放、同ID冲突、深层非法事件隔离、真实代理200×8192B合法批次（正文1638826字节） |
| 日报大库 | 363640事件的既有假库，30秒每日预算，单遍两维度汇总27.658秒，failed/dirty=0、partial=false；之后新增smoke数据并未清理 |
| 大库备份/隔离恢复 | 697253888字节，FULL integrity_check均ok；源/备份/新恢复目标events=seen312040、batches1595、facts624080；SHA完全一致；备份67.476秒、恢复82.485秒，各在90秒子进程界限内 |
| 正式备份/恢复 | 118784字节；SHA `3e1f84f47d8cb02661b72ea08d66d2bd4734aedcf6d018a77b7106d7509f1112`；源/备份/新的隔离恢复目标均FULL完整性ok、数据计数0 |
| 异机与凭据恢复材料 | Studio实际LaunchAgent退出0，数据库SHA/字节/FULL完整性通过；protected/.env.analytics为0600且与HK当前文件一致，秘密不进入Git/交接包 |
| 回滚预检 | `--code --check-only`通过，恰好5个发布自有旧源码/package/admin文件，data_restore=false；未实际回退生产 |
| 进程持久化 | pm2 save、pm2-root enabled；两个生产timer enabled+active，systemd首次实际任务成功；隔离失败备份自动60秒重试也有真实成功回执 |

定向后端、操作脚本、前端交互验证及独立范围复审已完成。复审I1/I2/M1已关闭，无未关闭Critical/Important；随后PM2入口的最小集成修正由主控实机RED/GREEN另验。全仓TypeScript仍有原race-llm.ts三处旧错误，未宣称全仓类型检查全绿。

## 容量门槛：未通过，禁止开启采集

原验收要求不变：14个合成上传主体、完整84000条、P95≤500ms、P99≤2000ms、RSS≤256MiB、原3001健康P95增量≤50ms；所有门槛通过后才可约定首台真实测试机。

| 香港既有假库实测 | 10秒checkpoint、32MiB缓存完整运行 | 1秒checkpoint诊断、64MiB写缓存 |
|---|---:|---:|
| 已ACK accepted | 84000 / 84000 | 50400 / 84000，未完成 |
| P95 / P99 | 3080.58 / 5890.68ms，失败 | 6041.15 / 9433.67ms，失败 |
| RSS峰值 | 189984768B，通过 | 209756160B，通过 |
| 原3001健康P95增量 | 1.927ms，通过 | 2.746ms，通过 |
| 退避 | 140次503 | 31次WAL_PRESSURE/10秒；6次代理超时兜底UPLOAD_DISABLED/900秒 |
| 总结果 | **容量失败** | **完整性/时延失败**，未提前重试绕过Retry-After |

1秒配置仅为隔离诊断，**生产仍缺省10秒**。6次代理上游读超时的请求可能已提交但ACK丢失；存储计数比已ACK多1200正是需重放去重的场景，已确认数据与seen全部保留。另有早期watcher异常/父进程超时导致没有完整指标的运行，也保留为失败证据，不能外推为84000通过。

因此，当前可以做**关闭状态配置、鉴权、503/退避及端侧队列保留联调**，不能打开任何upload、加入灰度设备或扩灰。后续必须继续定位同主机SQL/提交/checkpoint与I/O长尾，原库、原门槛重新跑完整容量回执后，再做首台ACK/重放/续签/恢复测试和北京时间00点真实夜间验收。没有收到批次不能推断设备没有活跃。

端侧 `_failed_flush`的epoch retry_at_ms与main ticks_msec比较疑点、semantic_interaction少数属性类型仍需端侧核实；本次未改安卓/Godot代码，不声称已复现或修复。小可间歇不回复仍按原约定等自然复现，埋点发布不代表该问题已解决。

## 回滚与保存边界

上线前HK快照 `analytics-predeploy-20261013T005846Z`，112文件源码归档571510字节；SHA256 `d9ff628ba9a1b41beffeb1ea8946aace16f16fffb95b570a45673fb447573ad5`。原devices/config一致在线快照、env/PM2/crontab均在root私有目录，记忆原文另已SHA归档。

紧急一级：热关总闸并通过原配置API关闭analytics全局/SN覆盖；二级：停止本次维护timer/采集进程，仅恢复5个发布自有旧文件并重启公司后台。回退保留已接收DB/WAL/seen、稳定HMAC、新增文件、Nginx JSON503/900入口及其他业务配置，不恢复整个业务库、不覆盖别人的后来改动、不动个人服务。

Studio备份使用任务专用直连参数，仍校验同一HK别名的私钥与known_hosts；未改全局SSH配置。Vault入口当前未配置，不能声称秘密已存Vault。正式整机重启、真实夜间触发、端侧采集/联调未执行；已经执行的是定时任务手动启动及实际LaunchAgent首次拉取。

完整步骤见 [回滚记录](P003_ANALYTICS_ROLLBACK_20261013.md)。主控Ruling与复审记录归档在本项目review目录，包含最小90天事实存储、checkpoint子进程、64MiB页缓存、30秒汇总预算、新隔离备份128MiB验证缓存、关闭安装与采集放行分离等代价；没有放宽ACK持久性或容量门槛。

## 给端侧同事的资料

- [简短回执](P003_ANALYTICS_CLIENT_RECEIPT_20261013.md)：可复制给同事，明确当前允许/未放行项目。
- [联调说明](P003_ANALYTICS_SERVER_INTEGRATION_GUIDE_20261013.md)：配置、认证、批次/ACK、受控错误、退避、首台及夜间验收。
- [服务端合同](analytics-server-contract-v1.md)、[后台API](analytics-admin-api-v1.md)，交接包另附57事件JSON Schema。

署名：codex（OpenAI）| 2026-10-13
