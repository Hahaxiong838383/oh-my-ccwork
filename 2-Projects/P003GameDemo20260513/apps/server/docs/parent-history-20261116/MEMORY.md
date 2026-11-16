# C机小程序真实数据接续入口

状态：2026-11-16用户要求总结、更新记忆/skills、commit+push后**等待进一步实机测试**。归档轮不再部署、开关、造数据、构建安装APK或执行生产探针。

## 设备与当前能力

- C SN：`BJP00326081002000031`；public_id：`dev_50b5415662259045`。本轮历史授权binding_version=1、Ark epoch=2；未来须实时核验，禁止按这个旧值补归属。
- 两个R1摘要及历史对话读取已上线。184条旧消息（孩子92、小可92）、10页与DB逐字段一致；新真实页生产H5展示/刷新/退出通过，微信手机未验。对话数量是对应探针时点，不是永久值。
- 使用时长focus_segment全历史0；不是实际使用0分钟。mini008/009的Telemetry工作/开盖常量1/1与同源权威4/0冲突；mini009基线源修复已通过1883 JVM、40 Python、Release Kotlin和MCU输入门。未构完整签名APK、未安装、未OTA。
- mini009构建源`006ac68a29447e8bc14fb655206d87bbf1f771a3`，21:22回执提交`75378716195bda8e7414af97ffd8dbd0b109212b`，原APK回执SHA `bde6b3eff817b10f3abd6e1f0b8f514ef17d44e0283829f9f0c608df9624d3db`，明确未上机。源码修复基于它保留新R1能力，旧008补丁仅对照。
- mini009网络仍默认off：wire信封、原context、reason/实例、retryable ACK及token scope等与线上合同不兼容；不能只改合同名后开闸。原Telemetry时长链与新R1独立。

## 权威文件与产物

- [总回执](../records-r1/P003_MINIAPP_R1_SERVER_HANDOFF_20261116.md)：各层状态、接口、摘要口径、真实对账、缺口与回滚。
- [兼容性核查](MINI009-COMPATIBILITY.md)、[mini009用时补丁交付](MINI009_USAGE_FIX_HANDOFF.md)、[完整构建待办](MINI010_BUILD_READINESS.md)、[复盘](RETROSPECTIVE.md)。
- [生产历史manifest](MANIFEST.json)、[发布](RELEASE.json)、[真实对账](POST-RELEASE-PROBE.json)、[页面验证](BROWSER-CHECK.json)、[Air最终交付](AIR-FINAL-DELIVERY.json)。摘要的独立manifest在`../records-r1/summary-20261116/`，不要用旧全量回滚覆盖后续历史接口。
- Air指定总回执：`/Users/rayman.chen/Downloads/P003_MINIAPP_R1_SERVER_HANDOFF_20261116.md`，当次SHA `5ea7d385deb26c39c2c01abd1062692697f44349afc9a607a39a6dc19441aecf`；仓库与本机Downloads同字节。后续写入先核漂移、备份、替换、回读。
- 新小程序ZIP `P003_MINIAPP_C_HISTORY_20261116.zip`，SHA `d73521682ecbfb86ff08879a1af9fed1d9328f2a4c93ecbe5fc8b9e1e1913639`；mini009基线补丁ZIP `P003_C_USAGE_FIX_MINI009_BASE_20261116.zip`，SHA `aea287f1a9be0ab17d7a455bb9d0f7af70faeb3cb703e3e8dae7e0d8e52bdc64`。两机Downloads已核，补丁ZIP不是APK。

## Git归档锚

- mycc业务/首轮知识提交`203b63ad7a9c8f81e4708190be650923b5d34697`已push `codex/p003-mini008-realdata-20261111`并独立ls-remote核同；后续归档元数据提交在同分支，不改变已验源码。
- Android修复/知识提交`42eaa238a1254e5ac10ff87aaa95c4c57afd75be`已push `codex/mini010-usage-hall-fix-20261116`并核同，原mini009交付分支及主线未改。
- 共享记忆三文件仅本机外置运行态落盘，私有备份及逐文件摘要回执见[共享记忆回执](SHARED-MEMORY-RECEIPT.json)；没有把其他项目记忆或完整备份推到代码仓。

## 下一轮实机测试

1. 等用户提供/确认C所连接Windows入口及微信测试版本。旧回执只有Windows本地路径，不等于已具备远程入口；不要猜IP或擅访其他Windows。设备网络地址先查共享设备记忆并实时复核。
2. 核最新mini分支、构建源与序号；后继mini010只是暂拟。完整quick、Rust/Godot/base及签名审包还需完成，不能同名重打009或用主线APK替代。回读C pm path活动APK/SHA/签名/版本并保留回滚字节后再按当轮范围安装。
3. 保绑定/凭据/存档/未ACK队列。实际开盖MCU4/0、摄像头在位、无配对OTA/时钟阻断，普通使用跨两次60秒并合盖补尾；同event_id核入队→逐ID ACK→DB→usage→手机刷新，不补造历史。
4. 微信导入新真实构建、确认生产域名/体验版本和当前绑定家长；验184旧历史（以当时真实数量为准）、新消息刷新、日期分页、账号切换清理及错误账号404。旧demo/旧只读状态包不能代替新页面。
5. R1先按兼容性报告修订端侧协议并通过真实fixture/HTTP/SQLite，才安排单C开关和真实领取/获得/激活同record_id对账。缺原context旧事实保持unattributed，不能把当前grant补给过去。

本轮源码测试、生产发布、浏览器验证与后续真人结果各自留时间和证据；没有现场证据就保持待验。

署名：codex（OpenAI）| 2026-11-16
