# v375 生产部署与恢复记录

结论：最终856候选已部署，服务端就绪；单038云端配置已启用，真实端侧闭环待验。对外回执见 [P003_V375_SERVER_READY_AND_JOINT_TEST_20261102.md](P003_V375_SERVER_READY_AND_JOINT_TEST_20261102.md)；精确运行/测试/私有证据摘要见 [DEPLOYMENT.json](DEPLOYMENT.json)。

- 业务856552b942f5f8c2feb08db5949ebe7080eff77f；实现交付cad5c72a1a10888741450ed9b7c15cce30df194a；45审计7d4416f34d8c97102ac76199877246b6a6086c06。
- 发布时间UTC：2026-11-02T13:55:55.204128+00:00～2026-11-02T13:56:01.650032+00:00。21目标before匹配；接收端先ready、主后台再ready、HTML最后发布。两次重启前房间数/倾听活跃会话均0。
- 备份 `/opt/p003/backups/v375-tiering-20261102T135555Z`：14个原文件/7个不存在记录、权限/owner/SHA、manifest、deploy-state.json；config/devices/analytics SQLite在线backup仅恢复取证，禁整库回灌。源码回滚tag `rollback/p003-v375-runtime-pre-20261102` →9e7aab98，远端核同。
- PM2仅analytics 3912736→3937833，主后台3915154→3937878；个人服务1626403保持。Worker/SFU及独立3007/3008未重启，generation保持，非Analytics runtime_flag/device_config逐行对备份完全相同。
- 最终311文件无意外变化；实际公网admin SHA c4a47f1025247df39cf80be421c7e2f58f64a269d0eb74e2dd07909485cf1634。真实浏览器未复验（CUA无浏览器）；隔离WebKit已45项通过。
- 本次第一次解包验证误用无顶层目录路径而ENOENT，发生在暂存目录、未写生产；核包真实前缀后修正，完整guards/备份后才部署。Air当前DHCP地址通过mDNS现查，复用既有Air ED25519指纹严格校验，没有接受未知密钥或改SSH配置。

## 操作回滚

1. 首选当前后台/API按目标SN保存 request_gzip_enabled=false、tiering_enabled=false、aggregate_upload_enabled=false、on_demand_capture_enabled=false（GET最新revision后PUT expected_revision）。capture=false会撤销请求、显式upload=false/id空；回读公网配置并等端侧应用。不要只删配置键。
2. **保留856接收兼容层**。端侧已经durable排队的新聚合/样本/压缩仍可能到达；直接换旧解析器可能terminal reject，丢掉队列。
3. 兼容接收服务本身故障才考虑源码回滚：先暂停现有Analytics上传总闸并核JSON503/ANALYTICS_UPLOAD_DISABLED，确保客户端保队；普通语音/Ark链路独立。记录当前策略revision与单038/23，不能擅自扩设备。
4. 对照[已核清单](../v375-tiering-20261102/DEPLOY_MANIFEST.json)，只恢复当前SHA仍为after的目标；有新漂移就先合并。使用本次实际备份；7个新增文件仅原不存在且当前仍after时删除。仅重启受影响analytics/voice，保留全部数据库、seen与新业务数据。禁止回退6c2f旧树抹掉BLE。
5. 新队列未确认排空时，旧代码上传保持暂停；恢复上传应具备本轮兼容解析/ACK能力。完整流程见[DEPLOY_ROLLBACK](../v375-tiering-20261102/DEPLOY_ROLLBACK.md)。

## 后续验收与经验

- 单机配置cfg61于22:00:23生效，诊断request `diag-15f09d45-9c84-4fa9-8937-fae9509152b8`，到期2026-11-03 00:29:59.878 CST；TTL对23点日批留出约90分钟重试余量。本地capture到期不自动关，不能说全部采集已关闭。
- 云端分步保存不是设备逐步实测；以真实Launcher/PCK应用回执为准。按需request不强制HTTP；无需改23点/总闸来制造到账。
- 幂等seen永久与payload TTL分开；aggregate必须按服务端receivedAt闭合且重放seen优先。首候选0e29被独立测试阻断并修复，不能用旧包。
- 当班等待真实RID/ACK：日批对账、真实PCK桶、11/5首次闭合与完整7天节省率；未达成不标通过。容量上限仍4台，避免用合成节省率扩容。

署名：codex（OpenAI）| 2026-11-02 CST
