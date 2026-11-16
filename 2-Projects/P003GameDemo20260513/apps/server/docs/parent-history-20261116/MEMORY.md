# C机小程序真实数据接续入口

状态：用户明确要求实施兼容、恢复上传、完成联调后等待明天。服务端于2026-11-16 23:11:30上线，C上传配置已开cfg-182；接口集成和线上H5验证通过。实际设备新流水、修复签名APK和微信手机验收待2026-11-17现场。

## 设备与当前能力

- C SN：`BJP00326081002000031`；public_id：`dev_50b5415662259045`。本轮授权binding_version=1、Ark epoch=2；将来先实时核验，禁止据旧值补归属。
- 两摘要与历史读取已上线。23:16新版H5读取186条历史、10页无重复、刷新20条、退出清理通过；21:32时184条（92/92）曾与DB逐字段一致。计数随时间变化，不宣称全部历史完整。
- 兼容采用同POST精确legacy分支、一张原始表、读时投影、单C完整历史授权；临时失败503/429保原ID重试。baseline不算收入或获得，不伪填原origin。仅C配置行改变，其他设备和PM2进程未动。
- 生产Node22.22.2与本地Node24各199/199；小程序101/101、TypeScript、微信/H5构建通过。新包9个H5文件与本轮实查构建逐字节一致。全仓既有listening-content.ts:29 GeminiLlmClient.abort类型错误仍在。
- 使用时长缺失：mini008/009精确Telemetry私有1/1枚举与同源权威4/0冲突，原始focus_segment为0，不等于使用0分钟。修复保留全部mini009 R1能力，Android联合提交d569775已推送，JVM1889/1889、Release Kotlin、Python records14通过。
- C最近自报仍371_mini_008，不等于活动APK SHA回读。当前v1/legacy业务流水均0，usage.available=false/focus_minutes=null。服务器能接且开关已开，不代表设备已R1补传。
- mini009精确构建基线`006ac68a29447e8bc14fb655206d87bbf1f771a3`；原交付提交`75378716195bda8e7414af97ffd8dbd0b109212b`未改。尚无修复签名APK、安装或OTA；联合交付为源码补丁。

## 权威文件与产物

- [总回执](../records-r1/P003_MINIAPP_R1_SERVER_HANDOFF_20261116.md)、[11月17日交接](../records-r1/compat-20261116/HANDOFF.md)：当前状态、产物、边界及同ID验收步骤。
- [兼容性核查](MINI009-COMPATIBILITY.md)、[构建待办](MINI010_BUILD_READINESS.md)、[复盘](RETROSPECTIVE.md)。原历史/摘要证据保留，不用旧整库回滚覆盖新数据。
- 最新脱敏证据目录`../records-r1/compat-20261116/`：MANIFEST、NODE22-TESTS、RELEASE、POST-RELEASE-PROBE、FINAL-STABILITY、BROWSER-CHECK、DELIVERY。私有生产回滚目录`/root/p003-records-compat-20261116/source-backup`，先关C再恢复本轮源码/环境，绝不整库回灌。
- 用户指定总回执`/Users/rayman.chen/Downloads/P003_MINIAPP_R1_SERVER_HANDOFF_20261116.md`，本机Downloads有同字节镜像；最新摘要见DELIVERY.json。旧21:54及设计版摘要只作历史锚。
- 当前小程序ZIP `P003_MINIAPP_COMPAT_20261116.zip`，SHA `99867d8ff0d4b60d96bfc7458eac0b7d8152fb5a5cb304964bca4b9668d2afa9`；联合源补丁 `P003_C_USAGE_AND_R1_SCOPE_FIX_MINI009_BASE_20261116.zip`，SHA `77e6800ca399301a23c4d30eb3aa50955ec3a555a5b54b660aa7f4110325eb6a`，不是APK。

## Git与记忆

- 服务端/小程序功能提交`0cb214753cd46dd7acbf54f701c1e84801bce116`；归档继续同分支`codex/p003-mini008-realdata-20261111`，最终推送摘要以收口回执为准。
- Android联合修复`d56977517487cd6002ef16cf3ba266af24aac9ca`已push并远端核同，分支`codex/mini010-usage-hall-fix-20261116`；原mini009交付和主线未改。
- 共享记忆仅本机外置运行态落盘，逐文件私有备份与摘要见[共享记忆回执](SHARED-MEMORY-RECEIPT.json)；不把其他项目记忆和完整备份推到仓库。

## 明天现场

1. 核C所连Windows/正式构建入口、实际活动APK/SHA及最新mini编号；下一候选010暂拟，不能同名重打009。当前没有已知可用远程入口，不猜IP或访问其他Windows。
2. 由Android修复分支完成正式签名包，保绑定/凭据/存档/未ACK队列覆盖升级。读取cfg-182，真实领取/获得/激活，同record_id核设备→ACK→DB→家长API→微信页面，重复与离线重放不重计；旧指纹队列先核save，不清空或批量重挂。
3. 真开盖MCU4/0、摄像头在位、非配对OTA/时钟阻断，普通使用跨两次60秒并合盖补尾，同event_id核focus_segment与usage。旧缺测分钟不推算。
4. 导入当前小程序包，用真实绑定家长验186及后续历史、日期分页、刷新、换账号和退出；昨日收益次日按真实到账核对，不改时钟造样本。

本轮交付后等待2026-11-17联调；不自动安装、造业务数据或扩到其他设备。后续明确授权优先于先前等待状态。

署名：codex（OpenAI）| 2026-11-16
