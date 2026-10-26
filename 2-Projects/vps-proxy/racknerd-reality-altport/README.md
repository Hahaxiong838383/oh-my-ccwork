# RackNerd Reality 备用入口

2026-10-27 为手机 v2rayNG 增加 TCP 14443 → 本机 TCP 2443 转发，复用现网 sing-box Reality 认证。

本目录保存不含凭据的已部署 systemd unit 和 [脱敏验收摘要](ACCEPTANCE-20261027.json)；UUID、密钥和完整导入 URI 不入库。排查、验收和回退见上级目录 `2026-10-27-RackNerd手机节点连接排查与备用入口.md`。

`racknerd-reality-altport.service` 对应服务器 `/etc/systemd/system/` 同名文件，使用已有 `/usr/bin/socat`。后端由原 `sing-box.service` 独立管理；`After=` 仅在两者均参与启动时排序，不会主动拉起后端，也不保证后端就绪。备用入口已启用开机自启，尚未重启服务器验证冷启动。

`Restart=on-failure` 处理转发主进程失败，不会因线路不通而自动换节点。用户已确认手机使用 14443 恢复；跨服务器兜底仍须由客户端执行。

转发会令 sing-box 看到来源为 127.0.0.1，按客户端源 IP 的审计应在公网入口采集。此入口不修改原 TCP 2443、UDP 36712 或电视分流。
