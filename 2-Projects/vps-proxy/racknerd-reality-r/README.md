# RackNerd 自有 SNI 双栈入口

2026-10-29 已部署独立 `racknerd-reality-r.service`，TCP24443，SNI `r.chenchuan.cc`。
服务端真源 `/etc/racknerd-reality-r/config.json`（600），原凭据保持；目录只保存无凭据 unit 与脱敏验收，不收录 URI、私钥或完整生产配置。

入口 IPv4 `142.11.225.39`，IPv6 `2607:9d00:2000:28b::2f70:e3d`。
监听 `::`，本机 `bindv6only=0`；是否双栈以两种地址的真实客户端请求为准。
unit 已 active/enabled，尚未重启服务器验证冷启动。原2443/14443、HY2与WSS服务保持。

新增部署需在原 VLESS 配置的受限副本中保留 users、flow、Reality keypair/shortId，
仅调整该独立入口的 tag、listen、port、TLS server_name 与 handshake.server。
先做配置检查、目标TLS/证书/h2检查、端口占用和防火墙核对，再启动；完整步骤见
[迁移双栈 skill](../../../.claude/skills/xray/references/migration-dualstack.md)。
不直接改变现用入口的 SNI，也不把 r 域名 DNS 改成 VPS 地址。

证据见 [ACCEPTANCE-20261029.json](ACCEPTANCE-20261029.json) 和
[后台测试报告](../2026-10-29-RackNerd双栈手机节点与电视后台验证.md)。电视IPv6大载荷首轮失败保留，后两次成功不代表长期稳定。
两条手机链接为独立节点，需要手机支持相应地址族，未部署自动切换。

回退仅涉及本入口：停止并禁用 unit，移除 comment 为 `racknerd-reality-r-dualstack` 的精确 TCP24443规则（IPv4/IPv6），
恢复 `/var/backups/racknerd-dualstack-20261029T143000Z/` 内本入口配置；不要清空防火墙或停止原 sing-box。
回退会中断已使用本入口的客户端。Cloudflare运维域名本轮按用户要求搁置。
