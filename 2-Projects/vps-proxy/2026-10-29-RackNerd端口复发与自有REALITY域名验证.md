# RackNerd 端口故障复发与自有 REALITY 域名验证

> 后续状态（2026-10-29 22:40 CST）：新 IP 已接通，自有 SNI 的24443双栈入口已启用；Cloudflare 运维域名按用户要求搁置，电视正式配置未切换。以[双栈节点与电视后台验证](2026-10-29-RackNerd双栈手机节点与电视后台验证.md)为最新状态，下文保留对应时点证据。

2026-10-29；codex实施验证，用户指定Grok独立只读分析。

## 已证实与未证实

- 10月27日：家庭到2443回程握手失败，22/80/443可达；新增14443转发同一2443后端，认证不变，家庭与用户手机恢复。
- 10月29日：家庭到22/80/443/2443/14443均超时；两侧包头及同接口正锚支持Rack回复未抵达家庭网卡。日本到原端口仍通，原服务/认证与源IP封禁已核。
- 本轮08:52左右，家庭22/443/2443/14443仍4秒超时。独立新24443也TCP超时。因此目前多端口路径故障持续，并非仅旧入口配置问题。
- 更换端口可以暂时避开当时某个入口受到的过滤/路径问题，不等于提供独立IP或线路冗余。故障后来扩大到更多端口，可能涉及路径/过滤策略变化，但证据不能确定运营商、GFW、触发时间或触发规则。
- 更换SNI发生在TCP建立之后；本轮失败发生得更早。不能将“微软伪装目标有问题”作为已证实根因，也不能承诺自有域名免封。

## r.chenchuan.cc 实际验证

从RackNerd源站读取到旧配置server_name与Reality handshake.server均为www.microsoft.com。目标r.chenchuan.cc解析为Cloudflare地址，不回指RackNerd自身；严格校验证书成功，TLS1.3、ALPN h2，叶证书SAN正确，有效至2026-12-07。

新增隔离候选`racknerd-reality-r.service`：

- `/etc/racknerd-reality-r/config.json`，目录700、文件600；复用原UUID/Reality私钥/shortId，不轮换、不输出。
- 仅改server_name与handshake.server为r.chenchuan.cc，新监听24443；配置检查与unit检查通过，原sing-box及原14443不重启。
- 家庭临时Xray直接到24443，真实代理两个目标均8.009秒超时、零正文。随后独立TCP探测4.004秒超时。
- 同一候选认证通过现有日本SSH管理链路到服务器回环24443：CF trace211B、RackNerd出口正确，IANA6253B/标题正确，约6.3秒。
- 这证明r域名及新服务端认证/出站在可达管理路径上可用，不证明家庭直连或生产中转质量；SSH转发不是交付给手机的公网节点。

由于家庭直连仍失败，未把候选发布为“已修复手机”的主节点。测试后已停止候选服务（inactive/disabled/MainPID0）、关闭本次24443监听并删除精确`racknerd-reality-r` UFW规则；配置与unit保留，供以后在可达路径上继续使用r域名。没有向手机交付一个已知家庭不可达的新链接。

最终原sing-box PID2984761、socat526926、CF WSS1987152仍active且NRestarts0；原配置SHA256保持`1cfa7b5aa32755aac2e362369df0d6dc75a5639683927d78db3167f39d7fdeed`。电视、本机生产代理均未改。

## 与 Cloudflare WSS 的区别

r.chenchuan.cc目前托管在Cloudflare。REALITY将它用作服务器握手目标，不等于让实际代理数据由Cloudflare CDN转发。合法客户端的数据链路仍是“客户端→代理入口→RackNerd→目标网站”，握手目标可达性仍是一项依赖。

客户端的SNI应填r.chenchuan.cc，但节点地址必须填实际可达的代理服务器/中转入口；不能直接把节点地址换成这个指向CDN的域名并期待Reality自动穿过CDN。此前WSS模式则是客户端先连接Cloudflare、CDN再回源，两者不能混为一谈。

## 当前处置与后续

- 当前先使用已提供的ZGO Reality直连；CF WSS仅应急。手机网络/运营商/版本及ZGO稳定反馈尚未收到，不声称手机已恢复或自动切换已启用。
- 若需保留RackNerd出口，应验证独立可达中转路径；新Reality配置采用r.chenchuan.cc，避免再依赖微软目标。
- 不能原地只改服务器SNI而不改客户端；原14443是原2443的TCP转发，也不能自动识别/改写SNI。双入口迁移后再逐设备切换，电视还需遵守启动事务与回退清单。
- 这次并未将所有现网旧客户端迁移到r域名；更换握手目标与修复TCP回程是两项不同工作。

证据：`/tmp/racknerd-r-domain-20261029/`中的server-preflight.json、home-ports.json、reality-r-e2e.json、direct-new-port.json、test-retired.json。敏感参数仅源服务器配置，不入报告或Git。

## Grok独立复核

通过Codeg指定grok引擎完成，只读未部署。报告`/tmp/grok-racknerd-causal-review-20261029.md`；Grok独立复核原配置摘要、进程、家庭多端口超时和ZGO正锚，并从家庭/Rack验证r域名证书、TLS1.3、X25519、h2及静态正文。主agent的新入口真实认证测试是独立证据。

共同结论：本次故障早于SNI发送，换目标域名不能消除已观测TCP故障；r可作为新的握手目标。准确口径是两次均属于TCP可达性层、影响范围从当时单端口扩大到多个已测端口；不能将“多个端口失败”扩大为已证明整个IPv4所有协议/端口封禁。Grok未在本轮重新从日本测所有原端口，相关判断来自前轮第三地证据。

署名：codex（OpenAI）| 2026-10-29；独立复核：grok（xAI）

## 2026-10-29 09:09 CST IPv6只读核验

> 后续更正：客服确认迁移前机房为 San Jose SJ259KVM，不支持原生IPv6；本节当时引用的“洛杉矶”资产记录已失效，不能作为该旧实例资格证据。

服务器内核all/default/eth0的disable_ipv6均为0，但物理eth0只有fe80链路本地地址，没有公网IPv6、没有IPv6默认路由；curl强制IPv6出网失败。监听[::]:22/80/443仅证明套接字存在，不能当公网IPv6已配置。未访问账号控制台，因此不能区分供应商未分配与已分配但OS未配置。

家庭有公网IPv6，直连ops.hahaxiong.top的IPv6 HTTPS返回401正常鉴权（1.014秒）；另一目标www.cloudflare.com/trace的IPv6请求超时，不能泛化全部IPv6目的可达。手机网络仍未知。

当前官方KVM VPS页面https://www.racknerd.com/kvm-vps 的FAQ明确：洛杉矶及法国机房可通过工单申请最多100个免费IPv6地址。此机记录为洛杉矶，但实际分配、前缀/网关和该实例资格尚未从控制台/客服确认。没有提交工单、改变网络、重启或新增IPv6代理。IPv6可能提供独立于当前IPv4地址故障的入口，仍须配好后从手机实测，不能保证不受限或更快。证据/tmp/racknerd-ipv6-check-20261029/。
