# RackNerd 手机 Cloudflare WSS 入口

> 2026-10-29 22:40 当前状态：迁移后 ops.hahaxiong.top 返回522，用户明确搁置域名维护；本入口未恢复公网验收，不能按早间结果推荐为当前可用备用。供手机导入的候选已在家庭网络验证（非手机蜂窝），见[双栈验证报告](../2026-10-29-RackNerd双栈手机节点与电视后台验证.md)。

> 2026-10-29 08:30更新：用户手机已连接但缓慢/不稳定后断开，**CF入口降为应急备用**；优先试已验证的ZGO443 Reality直连。手机稳定恢复与自动切换仍未验，下面初始部署测试只代表当时家庭短窗。

2026-10-29 新增独立入口，供客户端直连 RackNerd IP 多端口超时时使用。客户端 → Cloudflare HTTPS8443 → 本服务 → RackNerd 出口；原 Reality/HY2 和 Caddy443 不变。

## 已部署真源

- unit：`/etc/systemd/system/racknerd-mobile-wss.service`，本目录为已部署无凭据原件。
- 配置：`/etc/racknerd-mobile-wss/config.json`（目录700、文件600）；本目录 `config.example.json` 仅是脱敏模板，不能直接运行。
- 程序：`/usr/local/bin/sing-box` 1.14.3；active/enabled、Restart=on-failure、5秒间隔。enabled不是冷启动验收。
- 入站：VLESS / WebSocket / TLS，TCP8443，`ops.hahaxiong.top`，path `/racknerd-mobile`；无Vision flow，无Reality参数。
- UUID从服务器现有配置在内存复用，没有新增或轮换凭据；真实配置和手机URI不进入Git。
- UFW仅新增IPv4 TCP8443规则，comment `racknerd-mobile-wss`。

## 证书生命周期

Caddy是唯一续期方。新服务直接引用现有持久Docker volume中的LE证书与私钥，不另开ACME、不复制密钥。TLS叶证书当前到期2026-12-03，主机名/系统CA验证通过。

sing-box 1.14.3源码会监视certificate_path/key_path父目录，同目录原子替换可触发重载；整体移动父目录或symlink远端目标不在本结论内。检查无watcher告警只证明当前未见告警，尚未等待真实续期验证。未来Caddy证书存储路径改变必须同步核新服务；默认warn级别不会显示成功重载的Info日志，不能因未见成功日志而判失败。续期验收必须在源站本地8443实际握手检查新叶证书；Cloudflare边缘证书不能代替源站证书，也不能只查磁盘文件。

## 验收与故障边界

本次家庭隔离Xray直连域名8443，严格TLS校验：出口IP为RackNerd、IANA有效正文、完整1MiB下载通过；随机错误UUID客户端负例失败且无正文；未以同步服务端日志进一步归因该负例。ZGO443另经现有原认证验证成功，是独立服务器备用。

Cloudflare支持HTTPS8443及WebSocket，但CDN可能断开长连接；网络变化/旧连接重连由客户端负责。`Restart=on-failure`仅处理服务进程退出，不检测家庭路径、不自动切ZGO。v2rayNG版本和实际策略组未核实，手机自动切换未部署，不声称永久稳定。

## 安全回退

只撤本次新增服务和端口，无需重启原代理或Caddy：

```bash
systemctl disable --now racknerd-mobile-wss.service
ufw delete allow proto tcp from 0.0.0.0/0 to any port 8443
```

保留配置可供复启。若彻底卸载，仅在确认回退后删除该unit与`/etc/racknerd-mobile-wss`，再daemon-reload；不得删除原sing-box配置或共享Caddy证书。

## 手机交付与备用

私密URI临时文件在本机`/tmp/racknerd-diag-20261029/`，文件600、目录700；不会随本目录同步。手机需要一次性导入新地址，旧链接的IP无法由服务器透明替换。

原生策略组更适合跨服务器选择，但需核实际手机版本和VPN设置。源码2.3.11：leastPing对应observatory，leastLoad对应burstObservatory；fallbackTag不代表逐请求重试，也不提供固定主备迟滞。任何自动切换都要手机故障/恢复及换网验收。

历史部署详见[此前排查报告](../2026-10-29-RackNerd再次失联与Cloudflare入口修复.md)。

固定源码依据：[sing-box1.14.3 TLS watcher](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/common/tls/std_server.go#L229)、[fswatch0.1.2目录监视](https://github.com/SagerNet/fswatch/blob/97bbfafb2e505c88287bbd9f06a67639395fc3f5/watcher.go#L64)。
