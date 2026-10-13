# P003 埋点服务端部署回执

**结果：容量优化与维护重叠验收已通过，优化版已关闭状态部署；首台真机和真实夜间联调尚未执行。**

首次部署完成：2026-10-13 11:53:47 CST；公网/API验收11:54，后台真实浏览器验收11:55，备份与异机拉取验收11:56。用户已授权开发部署及回滚准备。本回执不代表端侧真机、夜间上传或灰度验收通过。

## 15:58 容量优化增量发布（当前状态）

- 运行源码 `9b63e7e9135d667c807562fd1581b0ea04ce5a07`，10个文件逐SHA核验。新增单写worker、fact时间布局和TTL维度范围清理；主查询只读8MiB、writer64MiB，FULL/提交后ACK/原HTTP合同不变，无新增依赖。
- 原14×30×200负载，5分钟及所有门槛保留。独立上传全84000：P95 408ms/P99 554ms/RSS240.21MiB/189.6秒。与维护重叠全84000：P95 454.186ms/P99 809.460ms/RSS256286720B（244.41MiB）/193.646秒，原health P95增量2.959ms，ACK/raw/seen全对账，actor/monitor失败0。
- 重叠维护20.485秒成功，两维各939160事实，failed=0/partial=false；上传仍有198次503退避（忙104/WAL94），不能把200响应变快说成总吞吐提高。独立与重叠两轮均在5分钟内完成。
- 生产15:58:34完成，16:03:14独立复核：仅埋点进程更新至PID2899018/kill_timeout35000；3001 PID2817417/restart23、个人3002 PID1626403/restart0保留。全局false/0点、灰度名单空、总闸false，events/seen/batches/facts均0。
- 公网16:00:59：admin七类GET200，匿名/无效凭据401，有效Device Bearer上传JSON503/900，完整配置cfg-11 false/0；40次原health P95 2.614ms。没有做儿童语音或真机采集测试。
- 两个timer恢复active，生产rollup与backup真实执行Result=success/exit0；Studio实际LaunchAgent16:02:29核验2份备份、接收新1份、保存受控环境恢复材料。stage三端口全停，1006360条假事件及seen完整保留。
- 累计假库已超过1M/维度/日预算；本轮重叠汇总快照为939160/维度、在界限内。未放宽1M/30秒预算，不能推断超过1M的整日汇总也已通过。真机、午夜及端侧失败自动恢复疑点仍待联合验收。
- 快照 `analytics-capacity-predeploy-20261013T075722Z`；正向manifest `analytics-release-capacity-20261013T075722Z/manifest.json`。正向包SHA `06befd730422cd9a5b852abcc68ac5fa62ea66d6e9ba8db2061abb6b2d9a41a1`；5文件反向包SHA `c658bb87ceb11f7d85ab61a94b9deaeab3bdcea17633b5417fa01dce55fb81e1`，生产预检通过，尚未实际回滚。旧完整发布manifest保留。

本轮容量代码回退请用[容量增量回退记录](analytics-capacity-rollback-20261013.md)，只恢复5个旧文件、只重启analytics，不用旧整体回退命令重启3001，不回退数据库。生产package.json未改。以下保留11:53首次发布与失败实验历史；不能用旧PID或旧容量结论代替上面的当前状态。

## 首次发布记录（11:53历史快照）

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

## 首次发布容量失败记录（历史证据，后续优化结果见文首）

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

首次发布因此限制为关闭状态联调；后续原库原负载优化验收现已通过（见文首）。开关仍未打开，下一步约定首台ACK/重放/续签/恢复测试和北京时间00点真实夜间验收，不直接全量放开。没有收到批次不能推断设备没有活跃。

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
