Grok 4.7。只读，未改代码、未跑测试、未 SSH、未派 agent。

只审 `b9114ac` 相对 `72053ae` 的 `voice_connect.rs`（+22/−1）。绿日志该文件 sha256 `86da9cc9…` 与 `b911` 一致：552 pass、0 fail、1 ignored。红日志 551 pass、1 fail，只有第 0 路 refused 和第 1 路约 250ms connected，没有 stagger cancelled；其文件 sha256 `202b0fcf…`，是已含红测的中间树，`72053` 为 `32e3f583…`。

丢关联已补上。`Diagnostic::dns` 在任务 poll 内保存 `Span::current()` 和 `get_default`。败者被 JoinSet abort 时，Drop 在 `WithSubscriber::poll` 之外；现于 Drop 中 `with_default` 后再 `enter`，取消事件回到原 subscriber 和 `connect_id` span。`enter` 守卫只在 Drop 同步块内。生产路径没有新的 `.await`。`take(8)`、250ms stagger、DNS 1 秒/2 次、IPv6 50ms 保持原值。Span 与 Dispatch 都是克隆，随 Diagnostic 释放，不把 `Entered` 留过 await，无泄漏。20ms sleep 只在测试里。

本增量没有具体阻断。同意受控主池部署，随后仍须 2 轮真实 RTC 验收。当前未部署。
