# 小程序简化绑定（2026-11-05）

服务端已上线，Android/小程序按新合同适配后进行C真机联调。普通绑定不再以工位/JSON声明为前置。

**mini003适用性更新（2026-11-05 16:48）：以下V3为`bind-sn + pairing_protocol:2`合同，不适用于后来收到的mini003 `ble-enroll-v2`包。该包尚需服务端v2兼容、BLE激活归因修复及小程序对齐，不要据本页旧上线状态直接通知mini003开测。详见[mini003审计回执](../mini003-audit-20261105/P003_MINI003_CLIENT_RECEIPT_AUDIT_20261105.md)。**

- [两端V3联调合同](P003_MINIAPP_SIMPLE_BINDING_V3_20261105.md)
- [服务端上线回执](P003_SIMPLE_BINDING_SERVER_RECEIPT_20261105.md)
- [实施范围](PLAN.md) / [独立验收](REVIEW-37.md)
- [部署清单](DEPLOY_MANIFEST.json) / [上线证据](RELEASE_EVIDENCE.json) / [回滚](ROLLBACK.md)
- [决策和经验](MEMORY.md)

旧auto-enrollment/QR V2文档保留历史；其声明前置不适用于当前普通内测绑定。
