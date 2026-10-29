# 2026-10-29 RackNerd 再次失联与 Cloudflare 入口修复

> 后续状态（2026-10-29 22:40 CST）：新 IP 已接通，自有 SNI 的24443双栈入口已启用；Cloudflare 运维域名按用户要求搁置，电视正式配置未切换。以[双栈节点与电视后台验证](2026-10-29-RackNerd双栈手机节点与电视后台验证.md)为最新状态，下文保留对应时点证据。

## 2026-10-29 08:33 CST 手机反馈覆盖此前候选主用结论

用户确认CF主节点能连接，但很慢、不稳定并再次断开。当前撤回CF作为手机默认主用的推荐，改为先选已交付的ZGO443 Reality直连；CF保留应急入口，没有擅自断开或卸载服务，也没有通过修改服务器来冒充已切换手机。TLS加密仍需保留，Cloudflare CDN提供的跨境路由并不保证大陆手机质量。

08:30–08:31家庭隔离客户端约56秒复测：CF、ZGO各10/10请求成功，分别含两次完整4MiB下载；并发测试的载荷平均速度（含建连）CF12.76/13.55Mbps、ZGO12.45/12.44Mbps。这是共享家庭带宽下的短窗对照，不是独占带宽测速、长期稳定性或手机体验证明；本次没有复现用户手机断连，不能据此否认反馈或宣称ZGO手机已恢复。

服务器回读新旧3个服务PID保持、NRestarts0、原配置SHA保持、可用内存730MiB；WSS近45分钟日志有14条EOF，EOF仅说明相应读操作遇到流结束，不能仅凭它判定异常、归属用户手机或归因CDN/客户端/运营商。journal MESSAGE可能是字节数组，读取须解码后再分类，不能把日志解析失败当作服务故障。

已询问手机Wi-Fi/移动数据、运营商及v2rayNG版本，尚未回复。手机无ADB，不曾替用户切节点或部署策略组。当前原URI/QR仍可用，ZGO标签虽写“备用”可直接选择；不发新参数增加导入负担。后续以手机原网络连续浏览/视频及换网反馈为验收。用户若要求保留Rack出口，另验真实中转入口与持续载荷，不能恢复推荐CF或随意换端口。


## 结论与验收边界

服务器新增 Cloudflare VLESS/WSS 入口已经从家庭网络通过原认证、有效正文和完整1MiB下载验证，并已设置自启。ZGO另一台服务器的原有Reality443也单独验证可用，生成手机备用导入文件。手机未连接ADB，用户尚未反馈导入结果；因此当前是服务器与家庭链路已修复验证，手机恢复和自动切换待验。

本次证据与10月27日不同：家里到RackNerd同一IPv4的22/80/443/2443/14443都超时，日本到这些端口均成功；不能继续把故障仅看作2443单端口问题。服务器原进程、认证与资源正常。具体造成路径异常的网络设备及突然触发原因尚未证实，不写成“已确认GFW精准封禁”或“密码过期”。

## 取证

| 层次 | 实测 | 意义 |
|---|---|---|
| 家庭直连 RackNerd | 上述5个TCP端口均4秒超时 | 影响多个入口与SSH，超出单个Reality配置 |
| 日本到 RackNerd | 5端口均成功，约114–135ms | VPS并非整体停机或全球不可达 |
| 家庭正对照 | ZGO22/443/11447约0.2秒成功，百度HTTPS200 | 家庭并非完全断网 |
| 原14443真实Reality | 两个外部目标均8秒连接超时 | 旧备用入口此时也不能完成实际请求 |
| 原服务 | sing-box PID2984761、socat PID526926，均active/enabled、NRestarts0 | 没有因主进程崩溃或反复重启导致中断 |
| 资源 | socat1进程/6FD，conntrack47/65536，可用内存714MiB，无OOM，磁盘66% | 未发现资源耗尽 |
| 旧日志 | 客户端reset和少量broken pipe | 不等于socat主进程退出，不能据此重启生产 |

补充源过滤与服务器包头核验：fail2ban仅sshd jail，当前封禁不含家庭来源；iptables/nft也未发现针对家庭来源的封禁。18秒同接口窗口中，家庭对22/14443每端口5个SYN抵达，服务器每端口发8个SYN-ACK，家庭仍超时；日本正对照两端口均1个SYN/1个SYN-ACK并成功。因此服务器收到并回复请求，但家庭连接未完成。家庭公网地址仅留私密临时证据，不归档。随后家庭eno1的12秒抓包中，Rack22/14443各发5个SYN、入站SYN-ACK为0；同接口ZGO443正锚收到SYN-ACK并195ms连接成功。两处抓包为先后窗口，观察到同类持续故障，结论支持回程回复未抵达家庭网卡捕获点，不能指定中间设备。

旧配置SHA256为`1cfa7b5aa32755aac2e362369df0d6dc75a5639683927d78db3167f39d7fdeed`，本轮保持；原14443unit SHA256为`f7a242c6bbabef38a645113ffc395da75ec8ae13c557e1b6d8710cee0e4610f8`。

## 实际修改

1. 使用已有橙云域名 `ops.hahaxiong.top`，新增独立 `racknerd-mobile-wss.service`，TCP8443、VLESS+WS+TLS、path `/racknerd-mobile`，继续RackNerd出口。
2. 复用服务器已有UUID；TLS直接引用Caddy持久volume的现有证书/私钥，Caddy继续唯一续期。未新建DNS、未轮换凭据、未另开ACME。
3. 仅新增IPv4 UFW8443规则。新服务独立权限限制、Restart=on-failure/5秒，先start及E2E，再enable。
4. 原sing-box、socat、HY2与Caddy443均不重载/重启；没有操作电视或手机前台，也没有修改本机生产Xray。

完整无凭据unit、脱敏配置模板、验收结果与回退在 [racknerd-mobile-wss](./racknerd-mobile-wss/README.md)。

## 验证结果

家庭使用临时Xray26.3.27、动态loopback SOCKS、memfd配置，出站仅新WSS，严格TLS校验，没有通过现有10808代理绕行：

| 请求 | 结果 |
|---|---|
| Cloudflare trace | 1.190秒，209B/16字段，出口23.226.135.149 / US |
| IANA | 1.260秒，6253B，实际标题正确 |
| 有界下载 | 2.066秒完整1048576B，含建连时间；不是长期带宽保证 |
| 随机错误UUID | 0.946秒失败、0B，错误UUID客户端负例；未用同步服务端日志归因 |
| 独立TLS | 源站本机8443实际证书CA/hostname校验通过，与源站443同证书指纹，TLS1.3；不是CF边缘证书 |
| 现有管理站 | 家庭直连443仍401正常鉴权；ops-caddy PID/启动时间/重启次数不变 |
| 新服务回读 | PID1987152、active/running、enabled、NRestarts0 |
| ZGO备用 | 现有443 Reality原认证：trace0.991秒出口38.49.38.237，IANA1.136秒6253B正确标题 |

全部临时Xray实例均在finally退出并回读确认。ZGO备用为已有443节点，和电视11447专用入口不同，没有猜参数换端口。

## 手机交付与后续验收

已生成三份私密文件（目录700、文件600，均未进入仓库）：

- `/tmp/racknerd-diag-20261029/racknerd-mobile-wss-vless.txt`：主用。
- `/tmp/racknerd-diag-20261029/zgo-backup-vless.txt`：独立备用。
- `/tmp/racknerd-diag-20261029/mobile-primary-and-backup.txt`：两节点一起导入。

已异步请用户导入主用、验证Google/YouTube并提供网络类型与v2rayNG版本，尚未收到结果。旧手机URI写死RackNerd IP，无法靠服务器改配置自动替换。

v2rayNG官方2.3.11已支持原生策略组；leastPing使用observatory，leastLoad使用burstObservatory，不能套“balancer必须burstObservatory”的旧泛化经验。fallbackTag不是逐请求重试或固定主备顺序，leastPing没有失败计数/恢复迟滞。手机版本、TUN/HEV和设置未知时，不交付硬编码SOCKS端口的完整custom JSON来冒充已配置自动恢复。

待手机可操作后：分别验两个节点有效正文，策略组做定向客户端故障/恢复、Wi-Fi↔移动数据及锁屏唤醒。不要停生产服务器来演练。配置时明确这是健康延迟择优，不能称为RackNerd固定首选的有序兜底。

## 稳定性边界与经验

- 同IP换端口只能抵抗部分入口故障，整个IP路径异常需要入口绕行或另一台服务器；本次提供CDN路径及ZGO独立备用。
- 进程Restart不等于网络健康检测。不能靠反复重启本来正常的服务修复外部路径。
- 服务active、TCP通、CDN101/HTTP200都不等于代理可用；验原认证、有效正文、出口与有界载荷，另加错误身份客户端负例；如果要归因认证拒绝还需同步服务端日志。
- Cloudflare可能因升级/空闲中断WebSocket，旧连接不会无缝迁移；不能承诺永不掉线。
- sing-box1.14.3会监视证书父目录；当前没有watcher告警，但真实续期/冷启动未验。证书路径后续迁移必须同步维护。
- 服务器与开发机测试不等于手机VPN实际运行态。用户确认“正常”前不能记为手机恢复。

官方依据：[Cloudflare端口](https://developers.cloudflare.com/fundamentals/reference/network-ports/)、[WebSocket](https://developers.cloudflare.com/network/websockets/)、[v2rayNG2.3.11](https://github.com/2dust/v2rayNG/releases/tag/2.3.11)。固定源码锚及详细调研在`/tmp/v2rayng-failover-research-20261029/`，原始脱敏取证在`/tmp/racknerd-recur-server-20261029/`。

署名：codex（OpenAI）| 2026-10-29
