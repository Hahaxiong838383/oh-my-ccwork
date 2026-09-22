# 2026-09-22 Air 入网入口恢复与香港 IPv4 路径调查

## 已完成

1. Air `/etc/easytier/node.toml` 已增量追加家内 `tcp://192.168.1.133:11010` 和公网 IPv6 `tcp://[2001:df1:7880:6::1ca]:443`；原配置逐字节保留，root 文件权限 0600。IPv6 候选配置 `--check-config` 成功，原始工具输出未打印，以免回显网络密钥。
2. 两条入口通过 CLI 动态接入，19:37 复查均 Connected。没有重启 EasyTier、Xray、路由器或远端服务；未做冷启动/断网验收。
3. `nodes/air.toml` 同步两条 fallback，避免将来部署模板抹掉修复；未用模板覆盖本机完整配置。
4. 已清理当前项目中三份脚本的已知设备明文 sudo 密码，同时移除 literal 凭据分派。dev198 改为 `secret:DEV198_SUDO_PASS`，凭据必须来自私密 env/凭据库；本机私密 env 当前未配置该变量，依赖它的部署/测试会明确失败，不偷偷使用默认密码。
5. 新的 `et_sudo_env` 将密码经 stdin 送入 SSH/sudo，不写 argv；子 shell 内关闭 xtrace，退出码原样传递。部署、卸载、巡检、KCP/网关测试相关调用同步修改。没有实际运行部署/卸载/停网测试脚本。
6. 凭据路由 8/8 测试、所有项目 Shell 语法检查通过。没有轮换设备密码、重写 Git 历史或清除历史提交里的旧值；历史泄露风险仍需单独处理。

## 时间线与证据（北京时间）

- 19:12：Air 仅能看到自身。所有既有 bootstrap 均失败；家内备用 `.119` 的 SSH 和 EasyTier 端口也不可达。
- 19:13：home-studio 经家内直连可登录且组网正常；公司 dev198 到香港 IPv4 22/443 均可达，Air 和 home-studio 同样测试超时。
- 19:15：动态加入 `.133` 后，三目标真实 SSH 登录恢复；证实是入口失效，不是本机进程崩溃。
- 19:18：经 home-studio 在 09-12 已保存的 SSH host-key 记录，使用 StrictHostKeyChecking=yes 登录香港。香港实际 ED25519 指纹与 home-studio 缓存一致；Air 的旧 known_hosts 没有改动，也没有绕过校验。
- 香港 EasyTier/sshd 正常监听，nftables 无规则，iptables INPUT 默认 ACCEPT 且无拦截规则；fail2ban 未运行。
- 19:19：香港 eth0 短时抓包收到家里出口的 SYN 并发出 SYN-ACK，多条失败会话反复重传未完成握手；UDP22 也可见香港发出回复。此时只有香港端证据，不能据此定位具体丢包设备。
- 19:30：Air 限目标/限时抓包期间 IPv4 自行恢复，看到 SYN-ACK 到达 Air、Air 回 ACK；**回复包含 ECN 标志 `S.E`，不能只按字面 `Flags [S.]` 计数，否则误报 0 SYN-ACK**。没改双方防火墙、路由器或服务，因此不能把恢复归功于 IPv6 配置修复了 IPv4。
- 19:34：四轮分别测 IPv4/IPv6 的 443 与 SSH，IPv4 443 仍有一轮超时，SSH 约 1.5–2.5s；IPv6 大部分 TCP 约 0.08s、SSH 约 0.17–0.20s，也有个别慢样本。只作为小样本，不宣称长期稳定性或量化丢包率。
- 香港 `ss -ti` 显示实际 IPv4 会话 RTT 约 220–240ms，多次数据重传。这是 TCP 证据，不是虚拟网 ping 的假象。
- 香港回家 MTR/PTR：前段含香港节点，后段出现 `lax01.atlas.cogentco.com`、`sjc13.atlas.cogentco.com`、`sjc03.atlas.cogentco.com`，再至移动骨干地址；**PTR 命名提示回程绕美，非对设备地理位置的绝对证明**。不能把某跳 ICMP 不回复/高 Loss% 当作该跳真实转发丢包。家到香港正向 traceroute 部分节点约 46–48ms，但未完整响应。
- 最后真实 SSH：Studio 0.264s，home-studio 0.150s，dev198 0.256s；监控 healthy。未把 banner-only 探测当作已认证登录。

## 根因边界

已确认业务故障机制：旧配置全部入口同时不可达，Air 无法入网；已确认上游 IPv4 存在实际超时/重传和不理想回程路径。最可能是香港供应商到家庭运营商的 IPv4 回程质量问题（有绕美迹象），但尚无路由器 WAN 抓包或运营商逐跳证据，不能断言具体是哪一跳丢包，也不能声称 IPv4 根治完成。

本次解决的是入口冗余与 IPv6 绕开差路径；不以自动重启代替上游网络修复。

## Lucky 是否可用

可用 Lucky **端口转发 / TCP 四层转发**，不要直接用 HTTP Web 反向代理转发原生 `tcp://` EasyTier。示意：公网/DDNS:端口 → Lucky TCP 监听 → `192.168.1.133:11010`；Air 配置 `tcp://域名:端口`。配置里的冒号不要写 `\:`。

仅公网 IPv6 的 Lucky 入口要求客户端网络也有 IPv6；普通 HTTP/CDN 橙云并不会提供任意 TCP 转发。若家庭 IPv4 位于 CGNAT 后，单纯 Lucky/DDNS 不会自动带来公网 IPv4 入站，需要可入站 IPv4 或额外隧道/中继。保留 EasyTier 私有网络认证/加密，不暴露管理 RPC 或控制台。

本轮只核对能力与架构，没有配置 Lucky 或打开新公网端口。

官方依据（2026-09-22 实际读取）：
- https://www.lucky666.cn/docs/modules/portforward （TCP/UDP，IPv4/IPv6 转发）
- https://www.lucky666.cn/docs/modules/web （HTTP Web 服务/反向代理）

## 根本措施顺序

1. 保留已部署的家内入口 + 显式 IPv6 + 原 IPv4，避免全部依赖一个地址族；离家时 LAN 入口失败属预期。
2. 给供应商提交带时区、目的运营商/出口、失败抓包、TCP 重传、反向 MTR 的工单，要求检查 IPv4 回程并提供更合适路由；暂不重置家庭路由器或改全局 TCP 参数。
3. 选已有、不同线路的第二公网发现节点（需单独明确部署范围），兼顾没有 IPv6 的移动网络；同一香港机器增加端口不是独立冗余。
4. 再按现场样本决定是否做有界自动恢复；没有任何可达入口时，反复重启无效。

2026-09-22 后续 Lucky 双栈入口与拓扑实施完成并经用户接受，本报告与密码清理代码纳入本次用户明确授权的 commit/push 和记忆更新。凭据历史清理、密码轮换及供应商工单发送仍需单独授权。
