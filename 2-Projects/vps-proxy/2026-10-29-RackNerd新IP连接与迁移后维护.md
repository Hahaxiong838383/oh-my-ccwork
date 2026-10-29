# RackNerd 新 IP 连接与迁移后维护

> 后续状态（2026-10-29 22:40 CST）：新 IP 已接通，自有 SNI 的24443双栈入口已启用；Cloudflare 运维域名按用户要求搁置，电视正式配置未切换。以[双栈节点与电视后台验证](2026-10-29-RackNerd双栈手机节点与电视后台验证.md)为最新状态，下文保留对应时点证据。

时间：2026-10-29 22:01–22:17 CST。用户提供新 IPv4 并要求连接验证；沿用此前迁移后整体维护授权。

## 结果

新 IPv4 `142.11.225.39` 的 SSH 与 REALITY 代理真实请求已从家庭网络直连通过。迁移数据保留，11 个 Docker 容器运行。首页和 SSH 监控的旧 IP 已修复。公网 `ops.hahaxiong.top` 返回 Cloudflare 522，DNS 回源配置尚未完成核对；手机与电视客户端尚未同步验收。

## 新地址与接入

| 项目 | 现场证据 |
|---|---|
| IPv4 | `142.11.225.39/26` |
| IPv6 | `2607:9d00:2000:28b::2f70:e3d/64` |
| IPv6 默认网关 | `2607:9d00:2000:28b::1` |
| SSH 主机 | `racknerd-54aa08d`；原私钥成功认证 |
| SSH 主机公钥 | ed25519 指纹 `SHA256:jBwD6sfRNbtCT12QeXgJ/gPk5jDBbVK7iYF8vi2TZfk`，与迁移前离线备份一致 |
| home-studio SSH 别名 | 新增 `racknerd` → 新 IPv4，直接连接，使用原 `id_ed25519_air`，严格校验主机公钥 |
| 机房 | 本次申请迁往 LA；新 IP 已由用户提供，CF IPv6 trace 的入口为 LAX；具体 LA 节点编号未取得客服回执 |

本机之前没有 `racknerd` 别名。其他机器的 SSH 别名尚未修改。旧报告的 IP 保留历史语义，不批量替换。

## 验证

- 家庭直连 TCP 22、80、443、2443、14443、8443 均成功；多数单次握手约 200ms，14443 有一次约 1.2 秒。这不是持续测速或手机运营商质量证明。
- 临时 Xray 使用新 IPv4:14443 与原 REALITY 认证，Cloudflare trace 返回 HTTP 200、出口新 IP，约 1.14 秒；IANA 返回 HTTP 200、6774 字节且正文锚通过，约 3.71 秒。测试进程已退出、含凭据临时配置已删除。
- IPv6 从 VPS 出网成功，家庭到新 IPv6 的 TCP 22、443 成功。代理现有端口仍只监听 IPv4，**尚未部署 IPv6 代理入口**。
- 变更前 12 个关键配置、证书、公钥文件与迁移前备份 SHA256 一致；系统无 failed unit，11 容器运行，有 healthcheck 的均 healthy。
- 本轮按用户要求未测试 HY2；未操作电视、未重启 VPS、未修改本机生产 Xray。

## 已实施维护

1. 远端及本地源码 `compose.yaml` 的 `HOMEPAGE_ALLOWED_HOSTS` 精确替换旧 IP；仅重建 `homepage`，不拉镜像、不构建、不重启依赖。
2. 远端及本地 `homepage/config/services.yaml` 的 RackNerd 卡片链接改为新 IP。实际 Homepage `/` 返回 200；`/api/services` 的响应包含新链接且不含旧 IP。运行容器环境读回新允许地址。
3. 备份 Kuma 后，短暂停止该容器，精确更新 monitor id=3 的 SSH 目标并恢复。更新前后 SQLite integrity_check 通过；重启后心跳 id=1350008、时间 `2026-10-29 14:14:05.935 UTC`、status=1，目标为新 IP:22。
4. home-studio 新增 SSH 别名并保存已与备份核对的主机公钥，实际 `ssh racknerd hostname` 验证。

仅 Homepage 和 Kuma 改变启动时间，另外 9 个容器保持。代理三个服务的 PID 仍为 sing-box=701、altport=702、WSS=700。

远端回滚备份：`/var/backups/racknerd-la-ip-20261029T141340Z/`（受限目录，含原配置及 Kuma DB）。本地证据：`/tmp/racknerd-la-check-20261029/`。本地与远端两份变更文件 SHA256 相同。

## 未完成与后续入口

- `ops.hahaxiong.top`：新源站 HTTPS 直连返回预期 401；通过 Cloudflare 返回 522。当前 Vault 同步后无 Cloudflare/DNS 对应凭据，已询问条目位置。尚未通过 API 读取源记录，因此不能断言其具体值；取得访问后核对并更新回源，复验公网。CF WSS 应急入口也依赖该域名。
- 手机：原 14443 节点需将服务器地址更新为新 IPv4，认证保持。尚无手机网络上的真实验收，不能宣称手机故障彻底消除。
- 电视：设备上旧 RackNerd 地址及启动事务副本未同步；涉及 `/data/adb/video-proxy/config.json`、九文件启动事务、生成的 worker 配置。维护需遵守无损播放约束并保证事务一致性，不能只修改单份配置。
- 自有 SNI `r.chenchuan.cc` 的独立候选仍 inactive/disabled，本轮不改变其部署状态，也不把该域名指向 VPS。
- IPv6 代理接入、手机长期质量和电视播放验收均未完成。

全量迁移前备份继续保留于 `/data/racknerd-backups/2026-10-29-pre-la/`，详情见同日备份报告。本轮未 commit/push；未将任何凭据、完整数据库或敏感备份加入代码仓。
