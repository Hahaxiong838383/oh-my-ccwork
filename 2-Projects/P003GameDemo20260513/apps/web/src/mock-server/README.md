# Mock Server (MSW)

详细契约见 [`docs/05-server-contracts.md`](../../../../docs/05-server-contracts.md)。

## 实现节奏

- **M3**：起首套 handlers（user/me + night-report + treasure/open）
- **M4**：加 focus 会话接口
- **M5**：加 ecosystem 状态接口
- **M6**：加 save/{slot} + settings/hardware

## 设计原则

- 服务器为单一权威：星尘/家族币/解锁/新手状态
- 所有计算（开箱等级、新手暴击、序列奖池）在 mock server 内完成
- 客户端只调接口，不参与奖励决策
- 未来切真后端：copy/paste handlers 到 NestJS/Hono 即可
