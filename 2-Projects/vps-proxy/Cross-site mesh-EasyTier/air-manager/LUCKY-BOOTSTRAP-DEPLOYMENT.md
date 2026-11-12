# NAS2 Lucky 双栈入网入口与 Air 拓扑 UI — 2026-09-22

## 已部署地址

| 入口 | 配置 URI | 作用 |
|---|---|---|
| 家庭 IPv4 | `tcp://mesh4.hahaxiong.cc:21110` | 公网 A → 家庭网关 UPnP TCP 映射 → Lucky |
| 家庭 IPv6 | `tcp://mesh6.hahaxiong.cc:21110` | 公网 AAAA → NAS2 Lucky TCP6 |
| Lucky 后端 | `192.168.1.115:11010` | NAS2 自身 EasyTier，组网地址 `10.10.10.22` |
| 家内 NAS | `tcp://192.168.1.115:11010` | 避免在家依赖公网回流 |
| 家内开发机 | `tcp://192.168.1.133:11010` | 保留之前已验证备用 |
| 香港 IPv4 | `tcp://85.189.55.23:443` | 原入口保留，不冒称坏回程已根治 |
| 香港 IPv6 | `tcp://[2001:df1:7880:6::1ca]:443` | 显式 IPv6 发现入口保留 |

动态家庭地址以权威 DNS 和 localhost:8888 页面解析结果为准，不将当次公网 IP 固化进 Air 配置。

## Lucky / DDNS 变更

- Lucky 3.0.0：新增一条 `EasyTier 家庭双栈入口`，TCP4 + TCP6 `21110 → 192.168.1.115:11010`。没有开启 HTTP/TLS 终止、PROXY protocol 或 Lucky 自定义流加密；EasyTier 自己保持原认证/加密。未暴露 RPC 或管理控制台。
- 现有阿里云 DDNS 任务只增加三个记录：`mesh4 A`、`mesh6 AAAA`、`fn2 AAAA`；原32条记录保持一致，共35条。
- `fn2` 的陈旧 AAAA 已改由 `{ipv6Addr}` 每60秒同步。权威 DNS 已查验，旧地址已替换。
- 既有3条 Web规则和子规则列表前后相等；管理端口16601及现有8666/16666不改。
- 本轮登录会话已通过 Lucky 正常注销；未持久化登录令牌或 DNS 凭据。

## 路由器映射与租约

- 发现并核对当前默认网关 `192.168.1.1` 为 Ruijie BE72-PRO。只使用该网关的已公布 UPnP WANIPConnection 服务，没有操作其他发现到的IGD。
- 新增 `TCP 21110 → 192.168.1.115:21110`，描述 `EasyTier-Lucky-NAS2`；新增前明确查询端口未占用，新增后回读一致。
- 请求永久租约时网关实际分配604800秒（7天），所以没有把它说成永久映射。
- NAS普通用户运行 `~/.local/share/easytier-lucky/nas-bootstrap-lease.py`，crontab标记 `# easytier-lucky-bootstrap-lease`，每5分钟核对；缺失或剩余不足一天时续租。端口目标/描述不属于本任务则拒绝覆盖。状态文件 `lease-status.json`，已有定时执行时间回读证明，不只验证脚本手动运行。
- 脚本不需要sudo、不储存凭据；状态目录与备份crontab为私有。没有改全局防火墙策略或重启路由器。
- **尚未做路由器/NAS断电重启验收**；设备存活后由定时任务恢复映射的代码路径有单元测试，不能当作物理重启已验证。

## Air 与 UI

- Air `/etc/easytier/node.toml` 增量追加mesh4、mesh6、家内NAS三条peer，权限0600，候选语法检查成功；旧字节和其他设置原样保留。
- 备份 `/etc/easytier/node.toml.bak-lucky-bootstrap-20260922-202547`。CLI动态添加同样三条peer，未重启EasyTier。
- 项目 `nodes/air.toml` 同步，避免后续部署丢失方案。
- 现有 EasyTier Tab 新增可折叠「方案拓扑与实际地址」，不是新建独立站点。图为发现/兜底拓扑，不声称实时业务流量都经过Lucky/香港。
- `easytier_topology.py` 只查询固定connector、两个固定DNS域名并输出字段白名单，不读取node config/网络密钥。显示历史外网验收与Air实时connector状态，过期数据不显示绿灯。
- 原监控每30秒采样，拓扑随同更新。只重载 `cn.easytier.air-monitor` 与 `com.xray.manager`；EasyTier PID 7842、Xray PID 3753均未变。
- Runtime备份：`~/Library/Application Support/EasyTierManager/runtime-before-topology-20260922-202937/`。

## 验收证据

- 公司dev198临时添加mesh4入口：connector Connected，NAS peer可见（p2p，udp/tcp）；只移除了测试connector，没有修改公司持久配置或重启。
- 香港中继临时添加mesh6入口：connector Connected，NAS peer可见（p2p，tcp6/tcp/udp）；同样只移除测试connector。
- 外部测试与本地分开：公司到家庭IPv4 TCP21110可达、香港到家庭IPv6 TCP21110可达。
- Air本轮真实SSH登录：Studio约0.46s、home-studio约0.15s、dev198约0.43s，均成功；后台healthy，3/3服务探测通过。
- **家内IPv4公网回流当前不通**：Air到公网IPv4:21110拒绝/连接中，而Air到NAS私网21110正常、公司到公网入口已验证入网。未将其伪装为Air已连接；页面专门提示在家使用LAN/IPv6，并与外网验收分开。
- 50/50 Python测试（原35 + 新拓扑/租约15）、JavaScript语法、SVG XML与PNG渲染验证通过；浏览器实际打开正式Tab，已目视拓扑与地址表。
- 自动重启仍未实现或启用；本次新增的自动化仅为NAS维护自己这一条UPnP映射。

## 回滚边界

1. Lucky只移除本次创建的21110转发规则；其key和不含凭据的规则快照在本机 `~/Library/Application Support/EasyTierManager/lucky-bootstrap-backup-20260922/new-port-rule.json`。
2. DDNS原记录与新增记录key在同目录 `ddns-records.json`，不含DNS账号密钥。回滚应先读最新任务，只撤本次新增记录，保留他人随后修改。`fn2 AAAA`修复正常，不建议恢复坏旧地址。
3. NAS只删除crontab中本任务标记行，其他行不改；然后仅在目标和描述仍匹配时删除21110/TCP的UPnP映射。原crontab备份在NAS脚本同目录 `crontab.before`。
4. Air先撤本次三个runtime connectors，再按最新配置增量删除对应peer块；不要盲目覆盖已被其他任务修改的完整配置。
5. UI回滚恢复两个原运行文件并移除新增topology模块/数据（如不再引用），重载页面/监控，不重启Xray或其他节点。

2026-09-22 用户验收后明确授权更新记忆并 commit/push；本次将家庭双栈入口、拓扑、此前密码清理一起按白名单收口，代码与共享记忆分仓提交。方案依赖NAS2常开及DDNS更新，不能当作家庭断电时仍可用；香港入口继续保留。提交回执见共享事件记录。
