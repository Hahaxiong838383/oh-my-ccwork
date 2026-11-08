八条都可以留。对照回执、Grok 审查、`DEPLOYED.json`、`POST_VERIFICATION.json`、`FORMAL_DNS_FINAL.json`，以及只读的提交关系，没有事实被打翻。第 7 条要把「本次现役」写成「发布前现役」：现在跑的是 `553629a0`、PID `3719988`；`057f1972` 是发布前备份和回滚目标。`ROLLBACK_CHECK` 已通过，生产回滚没有执行。

其余七条与证据一致。正式矩阵用 `rust-worker` 真名和 loopback 同版本隔离 SFU，故障只在该进程 mount namespace；生产三池在正式测试前后仍是 `057f1972` / `3593294` / `2446060`。备用是 200ms 按需、全进程 2 许可、不排队、无周期探测。故障用例的胜出行是 `tls_ws outcome=connected` 且 `dns_path=configured_upstream`。ANSI 误判留在 v2，v3 整表重跑，业务代码未改。`5453c80` 是运行源，`4ef4fd6d` 只补测试，`2f7fa9ba` 只记文档与证据，后者包含前两者但不是二进制来源。资源采样明确不是容量承诺。回执已写明本机上游是 Google/Cloudflare，历史故障和腾讯 DNS 根因都未证。

必须补上的三条：

1. 备用成功只认同一条建连日志上的 `outcome=connected` 加 `dns_path=configured_upstream`。同页里取消的 `independent_families`、正常路径和上线探针的 `system_resolver`，都不算备用已经生效。
2. 两道开关都要精确为 `1`，Agent 必须是 `rust-worker`，主机必须是 `cbm01.cn-huabei-1.xf-yun.com`。倾听池、搜索池不要开 hedge；ASR 主机进不了这条路径。`OnceLock` 会记住第一次的 `None`，首次建连前若还不是 systemd stub，本进程以后不再备用。
3. 快 NXDOMAIN、空回答和 200ms 内结束的失败不占许可、不查上游；两条路径一起失败仍按原 10 秒预算失败。DNS 这把 2 许可和 650ms 连接备用不是同一把。

署名：Grok 4.7（xAI）
