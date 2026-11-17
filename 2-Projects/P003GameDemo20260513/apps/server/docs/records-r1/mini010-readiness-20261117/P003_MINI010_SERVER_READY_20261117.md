# mini010 服务端就绪回签｜2026-11-17

**结论：服务端原格式兼容已经上线，C机上传配置有效开启。mini010按端侧回执保留现有wire即可开始联调，不再等待“服务端兼容尚未实施”，也不需要改成v1 context/origin格式。** 本回签覆盖所提供`P003_MINI010_SERVER_REPLY_20261117.md`第3节的未部署判断；不替代签名APK或实机操作验收。

## 1. 为什么双方结论相反

| 时间（北京时间） | 证据 |
|---|---|
| 11月16日22:34:01 | 端侧引用的主回执SHA `c906d5de8e34b23d789faeb14d4d2a252bb649bfea1678a81c578882dfb93441`属于兼容**方案稿**，当时尚未部署 |
| 11月16日23:11:30 | 兼容7文件发布完成，C下发`cfg-182`、`enabled=true`、`p003-ark-records-r1` |
| 11月16日23:24:55 | 两机Downloads主回执已替换为发布版`659f17…`，交付记录包含旧`c906d5…`→新文件的核验 |
| 11月17日10:50:41 | 本轮回环及公网复核：设备GET仍返回`cfg-182`与正确启用对象；7份兼容源码与现网逐文件SHA一致 |

因此这次“服务端没兼容”的直接来源是**端侧继续引用旧方案状态**。本次收到的回执没有真实上传失败的HTTP响应或拒绝ID。输入回执本身SHA：`d88816574d6cdd4e7c72079d0c695d91a95c87d4748d889fd468f610f17401fa`。

历史发布/交付证据：[RELEASE.json](../compat-20261116/RELEASE.json)、[DELIVERY.json](../compat-20261116/DELIVERY.json)、[两阶段Air交付记录](../../parent-history-20261116/AIR-FINAL-DELIVERY.json)。

## 2. 服务端要求已按原端侧合同兼容

C机：`BJP00326081002000031`，public_id `dev_50b5415662259045`。本轮仍为binding_version=1、Ark epoch=2；两者含义不同。

```http
GET https://kidshub-ai.hahaxiong.cc/v1/device/config
Authorization: Bearer <当前设备凭据>
```

设备实际返回的相关字段：

```json
{"revision":"cfg-182","ark_records":{"enabled":true,"contract_id":"p003-ark-records-r1"}}
```

上传仍为`POST /v1/device/ark/records:batch`，当前Device Bearer，JSON信封保留`schema_version=1 / contract_id / batch_id / save_id / coverage_from_ms / dropped_records / records`。

| 端侧事项 | 当前服务端处理 |
|---|---|
| v1 context与origin | **无需先调用`/records/context`，无需新增`origin_grant_id/origin_epoch`** |
| 合同名 | 使用原`p003-ark-records-r1`，不要改为带点的`p003.ark.records.r1` |
| 记录格式 | 原`baseline`、`business_commit`直接接收；保留record_id/save_id/sequence、原文与hash |
| 资源与物品 | 不要求端侧重做v1资源/实例映射，服务端只读投影已知字段；未知内容不伪造含义 |
| 旧历史及baseline | C当前明确授权范围内可接收；不要求补造发生时的owner/origin。baseline不计新增收益/获得 |
| 来源与时间 | 既有normal/gm/unknown按实保存；时间缺失/可疑保留原始事实和状态，不冒充正常收益 |
| 临时失败 | 容量/依赖失败整批503，限流429，按Retry-After退避；部分已入库记录原ID重放成为duplicated |
| 成功ACK | `data.batch_id`对应原批次，逐ID accepted/duplicated/rejected；rejected仅永久终态，不用HTTP200清整批 |

原合同16条/64KiB批量、32KiB单记录及ID长度限制保持；这些与端侧既有实现一致。当前设备凭据、绑定归属、单C授权、幂等冲突检查继续有效，不把其他家长或未知旧scope自动归入当前绑定。

## 3. 下一版端侧可以直接做什么

1. **保留启动默认false，但取消“服务端未兼容”的人工停用结论。** 收到上述有效配置后，通过现有`DeviceRuntimeConfigPublisher → ArkRecordsCoordinator`正常启用；无需增加新协议层，也无需将所有设备默认全开。
2. 回读实际配置revision、enabled、contract_id及配置应用结果。初始化固定日志`network_default=disabled`只说明默认值，不能据它判定当前有效开关仍关闭。若缓存或版本去重导致未应用，先核真实GET及配置消费链。
3. 保留mini010已修复的同SN＋binding_version稳定队列scope；续token不改变当前归属。遇到`save_identity_changed`先保留队列并回读绑定证据，这属于端侧本地归属，不能靠放宽服务端JSON或清库掩盖。
4. 覆盖安装准确候选后，真实领取/消费/激活，逐原record_id核`records_sending → records_uploaded → ACK → DB → 小程序数据`。Telemetry使用时长独立验证开盖4/0、在位、60秒片段及合盖尾段。

## 4. 本轮验证结果及边界

- **Node24：4组legacy回归49/49；生产Node22.22.2源码副本：同4组49/49。** 使用隔离临时SQLite与真实loopback HTTP，没有向生产写合成业务记录。
- 新增回归使用已有真实Rust序列化器输出，records逐字段保持原样，仅按Launcher原信封封装：首次上传两个原ID全部accepted，SQLite canonical原文/hash/coverage一致，家长查询可读；原批重放两个ID全部duplicated，无重复行。全程不调用context、不补origin。
- 现网回环及公网有效配置均200；故意缺少正文必需字段的验证批仅返回逐ID`invalid_record`，用于证明合同路由及准入已通过，**不计为业务上传成功**；过期绑定版本仍401。前后业务表计数未变。
- 10:52:55只读快照：C已有**1条legacy baseline**，接收于10:46:02，source_mode=unknown，dropped_records=0；v1表0。它在本轮探针前已存在，不能将baseline计为新奖励或声称正常领取已验。仅核数据库事实，未证明该行对应哪份活动APK。
- 10:53:14读取OTA记录：最新自报仍`371_mini_008 / code371`；自报不是活动APK字节回读。本回签未安装设备、未发布OTA，也未验证微信手机端操作。
- 本轮未发现需继续放宽生产schema的具体报文差异；**已有兼容保持生效，本次新增的是上传回归和纠正后的就绪回签**。未重复改配置、重启服务或扩大设备范围。

Node22隔离副本首次未复制`package.json`，导致ESM顶层await装载失败；补齐生产模块元数据后49/49通过。该环境准备问题未修改生产代码。

证据：[源码对撞](SOURCE-PREFLIGHT.json)、[现网准入](LIVE-READINESS.json)、[Node22](NODE22-TESTS.json)、[Node24](NODE24-TESTS.json)、[baseline元数据](LATEST-RECORD-METADATA.json)、[版本自报](REPORTED-VERSION.json)。主回执：[P003小程序联调回执](../P003_MINIAPP_R1_SERVER_HANDOFF_20261116.md)。

署名：codex（OpenAI）| 2026-11-17 11:04 北京时间
