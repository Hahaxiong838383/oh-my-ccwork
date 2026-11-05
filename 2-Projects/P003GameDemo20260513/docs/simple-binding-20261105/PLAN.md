# P003 简化家长绑定

按用户2026-11-05决策：普通内测绑定不要求工位、预置JSON、identity_statement、长期密钥登记、prove_enrollment或限时开窗。手机号由短信登录账号确定，请求业务字段只有SN。既有旧BLE协议保留兼容，不批量变更历史策略。

流程：短信登录 → BLE读取SN/当前会话nonce/recipient公钥 → bind-sn原子自动建档并归属当前账号 → pairing2 confirm → 配网 → 设备claim解密保存 → prefetch实际认证 → status activated → A真实数据/B隔离。nonce和recipient公钥沿用原加密投递，不是预置文件。

13亲自实现/发布，37独立审计原会话。原树分支codex/p003-auto-enrollment-20261104；源码回滚tag rollback/p003-simple-binding-pre-20261105=b31cd36bd0bb175a599ad0ae5009fb935daf5b23。

实现范围6个运行文件：profile、registry、pairing route/store、device credential、device session。pairing.db只加binding_version/activated_at两列；不新增数据库。主服务和Analytics共用鉴权文件，发布需重载两个进程；不覆盖听/搜/方舟不同源文件和个人站，不改设备开关。停新机自动建档可设置SIMPLE_SN_BINDING_ENABLED=0后重启主服务，已有归属/新凭据认证能力保留。

验收：隔离SMS verify、真实SQLite失败重试、原子owner、墓碑、ECIES、成功鉴权激活、跨会话/owner/version拒绝、Analytics独立reader、旧BLE/legacy回归；Linux网络命名空间实际线上main快照覆盖6文件，HTTP绑定/领证/遥测/家长读取/重启。短信运营商送达、Android/BLE/小程序页面真机仅两端适配后联调，不能用合成测试替代。

部署前重新核线上逐文件before哈希，精确备份并生成回滚脚本；新列保留，不整库回灌。旧复杂方案验收是历史证据，不等于简化模式或C机真机通过。

署名：codex（OpenAI）| 2026-11-05
