# jidinghe-armbian 稳定性与性能调研

> 调研日期：2026-08-29。目标是让 MGV3001-ZG 作为低功耗无头节点长期在线；不为跑分冒险修改兼容 DTB、内核或已验收的 eMMC 启动链。

## 一、结论

1. 盒子运行的 EasyTier `v2.6.4` 是当前最新稳定版，继续使用原生 systemd 部署，不迁 Docker、不装第三方 GUI 管理器。
2. EasyTier 主线已合入“数据流 echo 活性探针”，正面修复“进程和 peer 表看似正常、实际数据面已死亡”的僵死态；该提交尚未进入稳定 release，只跟踪下一稳定版，不在盒子上无人值守追 main。
3. 当前系统没有 CPU、内存、日志或 eMMC 瓶颈。Armbian 已启用 ZRAM，EasyTier 约占 31 MB，额外安装 `tuned`、`irqbalance`、`earlyoom` 不会带来可证明收益。
4. 现阶段最有效的防掉线措施不是换项目，而是把现有 `scripts/local-watch.sh` 适配到盒子：用 `10.10.10.1:22` TCP 数据探针识别假在线，连续 3 次失败才重启，并保留 1 小时冷却。该 watchdog 已于 2026-08-29 通过 systemd timer 部署。

## 二、设备与运行基线

| 项目 | 实测值 | 判断 |
|---|---:|---|
| CPU | 4 核 ARM64，最高约 2.016 GHz，`schedutil` | 当前无持续高负载 |
| 内存 | 1.8 GiB，可用约 1.5 GiB | 无内存压力 |
| Swap | ZRAM 897.6 MiB，使用 0 | 已有合理兜底 |
| 日志 | `/var/log` 50 MiB ZRAM；journald volatile，实际约 4.9 MiB | 不会持续磨损 eMMC |
| EasyTier | 约 31 MB；systemd `NRestarts=0` | 资源占用很低 |
| eMMC | 调度器 `none`；read-ahead 128 KiB | 无需套用机械盘调优 |
| 网络 | 百兆有线 + Wi-Fi；EasyTier IP `10.10.10.25` | 常驻优先有线，Wi-Fi 作备用接入 |

## 三、EasyTier 防掉线调研

### 3.1 官方主线：应跟踪，暂不直接部署

- [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier)：持续维护；截至调研日约 13.3k stars，最新稳定版为 [`v2.6.4`](https://github.com/EasyTier/EasyTier/releases/tag/v2.6.4)。
- 主线提交 [`636390e`](https://github.com/EasyTier/EasyTier/commit/636390ec38be250c04738a96de442d87ea889181)：`feat(peer): echo liveness probes on data traffic`。普通 ping 失败后，通过真实 peer 数据包的 token echo 判断往返链路是否还活着，可识别“控制面在线、数据面失效”。
- Issue [#2471](https://github.com/EasyTier/EasyTier/issues/2471)：P2P 路径不可用却继续被选中、relay 不接管、core 退出时可能卡住；已关闭，主线已有对应修复。
- Issue [#2485](https://github.com/EasyTier/EasyTier/issues/2485)：`v2.6.4` 多次重连失败后的行为问题仍为 open，升级下一稳定版时必须做断网/恢复验收。
- Issue [#2474](https://github.com/EasyTier/EasyTier/issues/2474)：子网代理覆盖中继公网 IP 会循环断连；本组网映射段不包含中继公网 IP，当前不命中。

升级策略：只跟随官方稳定 release；升级前保留当前二进制，升级后至少验证 systemd 自启、TCP 数据探针、P2P→relay 接管、断网恢复和冷重启。若失败，立即回滚 `v2.6.4`。

### 3.2 第三方 EasyTier 项目：当前均不替换原生方案

| 项目 | 活跃度（调研日） | 结论 |
|---|---|---|
| [EasyTier/easytier-manager](https://github.com/EasyTier/easytier-manager) | 官方组织，近期有提交 | 管理 GUI/服务编排，不修复 core 数据面僵死；无头盒子不安装 |
| [MajoSissi/easytier-docker](https://github.com/MajoSissi/easytier-docker) | 自动跟随 release | 适合容器环境；盒子原生 systemd 链路更短、内存更省，不迁移 |
| [fordes123/easytier-edge](https://github.com/fordes123/easytier-edge) | 近期维护 | 可提供 Cloudflare WSS 中继，但会增加第三方依赖并突破“发现过程完全自建”的边界，暂不引入 |
| [IceSoulHanxi/easytier-ws-relay](https://github.com/IceSoulHanxi/easytier-ws-relay) | 有维护 | 项目自述仍偏早期、问题较多，不用于常驻关键链路 |

### 3.3 本组网的自愈措施

`Restart=always` 只能处理进程退出，处理不了以下假在线状态：

- systemd 显示 active；
- TUN、虚拟 IP 和 peer 表都存在；
- 实际数据已经无法出入，节点从全网消失。

已有 [`scripts/local-watch.sh`](../scripts/local-watch.sh) 使用 TCP connect `10.10.10.1:22` 作为真实数据探针，不使用中继虚拟 IP 上会假丢包的 ICMP。盒子已部署同一机制：连续 3 次失败再重启 EasyTier，重启后冷却 1 小时；P2P 退化只告警，不误重启健康节点。运行参数见 [`nodes/jidinghe-armbian-watch.env`](../nodes/jidinghe-armbian-watch.env)，调度单元见 [`systemd/`](../systemd/)。

部署位置：脚本 `/usr/local/sbin/easytier-watch`，参数 `/etc/easytier/watch.env`，调度器 `easytier-watch.timer`。本轮未给盒子配置独立的 Kuma push URL，因此已具备本机日志与自动恢复，集中告警仍由既有 `linux-lan` 组网探针承担，避免两个节点复用同一个监控身份。

同时保持：

- `enable_kcp_proxy = false`：家↔公司已有低延迟直连，没有 KCP 收益证据；盒子当前服务里的 KCP/QUIC 环境覆盖应在下一次稳定性加固时移除并验收。
- 两条公网上游：`tcp/443` + `udp/22`。
- 两条家庭 LAN peer：`linux-lan` + `fnos2`，降低单一发现入口故障影响。
- systemd 设置合理的启动限速，避免网络未就绪时重启风暴。

## 四、Armbian 性能项目调研

| 项目 | 采用判断 | 原因 |
|---|---|---|
| [ophub/amlogic-s9xxx-armbian](https://github.com/ophub/amlogic-s9xxx-armbian) | **持续关注，人工升级** | 当前系统来源，S905L3B 在支持列表；但本机依赖 `meson-gxl-s905l3b-e900v22e.dtb` 兼容 DTB，禁止无人值守升级内核/DTB |
| [systemd/zram-generator](https://github.com/systemd/zram-generator) | 无需另装 | Armbian 已启用 ZRAM，当前 swap 0 使用 |
| [rfjakob/earlyoom](https://github.com/rfjakob/earlyoom) | 暂不装 | 可作为未来内存过载保护；当前可用内存约 1.5 GiB，无 OOM 压力 |
| [Irqbalance/irqbalance](https://github.com/Irqbalance/irqbalance) | 暂不装 | 百兆网络和低负载下没有 IRQ 热点证据，额外 daemon 无明确收益 |
| [redhat-performance/tuned](https://github.com/redhat-performance/tuned) | 不装 | 通用 profile 可能改变 governor、I/O 等已稳定参数，收益无法证明 |
| [prometheus/node_exporter](https://github.com/prometheus/node_exporter) | 按监控需求再装 | 只提供指标，不直接提升性能；小内存盒子不为“可能以后看”增加常驻服务 |
| [ThomasKaiser/sbc-bench](https://github.com/ThomasKaiser/sbc-bench) | 仅按需跑基线 | 适合升级前后对比，不是常驻优化器；压测时需监控温度和降频 |
| [tuo3657/rtw88-wifi-fix-s905l3b](https://github.com/tuo3657/rtw88-wifi-fix-s905l3b) | **明确不装** | 针对 RTL8822CS 完全无 WLAN / `rfe 255`，会改 DTB 和模块；本机 Wi-Fi 已能连接 `NETGEAR-5G`，风险大于收益 |

## 五、执行优先级

1. P0：保留 Android eMMC 恢复镜像和 SHA-256，禁止格式化恢复 U 盘。
2. P1：TCP 数据面 watchdog 已部署；下一步移除 KCP/QUIC 环境覆盖后做断网恢复验收。
3. P1：跟踪 EasyTier 下一个稳定版是否包含 `636390e`，不跑未发布 main。
4. P2：每月记录一次温度、内存、eMMC 错误、EasyTier restart 次数；只有出现瓶颈证据才调优。
5. P3：内核/DTB 只在可现场接串口或可从恢复介质回滚时人工升级。

任何“优化”都必须保留三个底线：不写入密码库内容、不破坏 eMMC 启动链、不把未发布软件放到常驻网络路径。
