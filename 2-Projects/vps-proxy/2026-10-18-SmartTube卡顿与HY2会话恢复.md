# SmartTube 卡顿、首页超时与 HY2 现网实例恢复

> 归档状态注：本文保留各阶段原始时序、失败结果和待验边界；“当前”“待验”“未commit/push”等仅对应各记录时点。发布状态与最新进展见[本次复盘](2026-10-18-SmartTube与四级代理复盘.md)。历史回滚记录不得直接覆盖后续正式版本。

2026-10-18 21:23 CST，codex（OpenAI）。本阶段结果：当时连接和SmartTube实际播放已恢复，60秒只读采样通过；长期复发仍未排除。后续四级代理迁移与待验边界见本次复盘。

## 结果与边界

21:23时网络连通性已恢复。故障定位到电视现网 sing-box 的 HY2 连接状态：同盒、相同出站参数、同一时间、相同探测方法，旧实例两目标均超时，新实例均成功。21:14:43 仅重建电视后台代理后，21:19:48–55 通过 SmartTube 相同 UID 的生产 TUN→Rack HY2 连续三次完整下载 YouTube 首页成功。

尚不能称全部卡顿已根治：QUIC连接状态失效的底层触发原因未证实。恢复操作时用户在DIYP直播前台，随后自行进入SmartTube播放，本轮只读观察确认恢复，详见末节。此次不是此前开机时钟/DNS故障复发，不能覆盖用户20:47已确认的冷启动正常结果。

## 故障证据

- 电视 boot `9a472032-6bf3-4691-ac8b-4bc837edf921`；原 sing-box PID2432，SmartTube PID6579。系统时间、5354真实解析正常，eth0无RX/TX错误或丢弃。
- 21:03:55 用户实际播放采样为1080p VP9、约2.8Mbps、解码drop/error均0，不能归因于4K解码负载。
- 21:05:46、21:06:36 SmartTube BrowsePresenter出现SocketTimeoutException/Read timed out，证明首页请求失败；它不能独立解释先前所有视频卡顿。用户退出播放后的MediaSession为空、下载不增长，不算卡死证据。
- 第一轮生产指定出口探针：Rack HY2访问gstatic/YouTube均8秒504；Rack Reality约495/1473ms成功；ZGO Reality约455/990ms成功。
- 同盒新建隔离sing-box（仅回环SOCKS，无TUN）四出口均能完整读取约0.95MB YouTube正文，均包含ytInitialData。此轮与生产第一轮时间不同，因此又做同时对照。

| 同时对照 / HY2 | 旧生产实例 | 新隔离实例 |
|---|---|---|
| gstatic generate_204 | 8.013秒，504 Timeout | 成功，delay670ms |
| YouTube首页 | 8.012秒，504 Timeout | 成功，delay2493ms |

RackNerd只读核验：服务器代理单实例、无重启、资源正常，无OOM/conntrack耗尽；近期五条错误为stream canceled by remote with error code 0，可为客户端超时后取消的后果，不据此归罪服务器。另一次IPv6出站不可达早于本次。journal MESSAGE原为字节数组，子代理首轮字符串统计无效，已按UTF8解码纠正，以上为复核结论。

## 最小恢复与验收

保留脱敏证据后，先确认boot、唯一PID、二进制路径、原配置SHA及check通过，再TERM准确PID2432、确认其退出，用原二进制与配置启动PID15685。没有改节点、账号、APP、DNS策略或冷启动脚本，没有重启整盒或服务器。原boot锁尝试失败后未发生停止动作；确认原worker不在、ready匹配当前boot后才执行受控重建，没有删锁或killall。

本阶段生产配置SHA始终为 `090fbf7e9e5d12f6b37410b52708d0ff380865af2e5a61bd5131e6a84713141b`。独立前后回读证明：boot、完整IPv4/IPv6策略路由、IPv4 NAT、IPv6过滤及前台ActivityRecord均相同；5354/1080/1081/19090全部归新单实例。SmartTube UID10082双栈实际路由仍为tun0。

一次性DEX以UID10082运行固定HTTPS GET，系统TLS验证，读取至EOF、上限2MiB，只输出统计。默认Android UA首轮返回302，明确判失败；添加桌面UA后仍不跟随重定向、不放宽成功标准。三轮结果：

| 轮次 | HTTP | 完整正文 | ytInitialData | 耗时 |
|---|---|---|---|---|
| 1 | 200 | 956860字节 | true | 2580ms |
| 2 | 200 | 954630字节 | true | 2391ms |
| 3 | 200 | 960524字节 | true | 1974ms |

生产日志关联同connection ID的UID10082、tun-in及outbound/hysteria2[hy2]，因此不是开发机代理、新临时客户端或ZGO SOCKS的替代验收。探针进程是app_process，不是SmartTube自身，结果只证明相同UID生产路由的完整载荷可用。

## 源码复核与后续注意

精确版本sing-box1.14.3/revision7054cac5124465ffdb145870d7c01885566711b1，依赖sing-quic75c3ac4fa12b：

- HY2缓存母连接，只要QUIC context及connDone未关闭便复用；单流读写超时不必清母连接。这支持旧会话失效的机制假设，不能当成已拿到QUIC内部状态。
- 故障时auto候选hy2/reality、interval5m、tolerance300ms。业务拨号失败删除健康历史，却不立即更新selected；没有有效历史时可能继续保留原选择。显示hy2不代表健康。
- **Clash delay探针不是纯只读**：结果会更新/删除健康历史并触发组选路；它发送HEAD，不读取body，不检查HTTP状态码。此前delay成功不得记成完整内容/视频成功，本轮最终另做了生产TUN完整正文验证。
- PUT /proxies/:tag仅支持Selector，不能手选URLTest；PUT /configs为空实现，204不代表重载；DELETE /connections会全局ResetNetwork，不能描述为只重建HY2。
- 下次复发先捕获生产业务错误及同时间新旧对照。可评估较短健康检测周期或基于真实正文的故障切换；本轮没有在恢复后的健康窗口盲改参数、降低画质或改缓存。

官方源码：[urltest](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/protocol/group/urltest.go)、[探针](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/common/urltest/urltest.go)、[HY2](https://github.com/SagerNet/sing-quic/blob/75c3ac4fa12b/hysteria2/client.go)、[引用回收](https://github.com/SagerNet/sing-box/blob/7054cac5124465ffdb145870d7c01885566711b1/route/reference.go)。

脱敏证据在 `/tmp/smarttube-stutter-20261018/`：same-time-hy2-comparison.json、before/after-restart.json、restart-result.json、production-tun-fullbody.json、probe-live-route.txt。隔离实例及含凭据配置、临时DEX和本轮ADB转发已清理。未commit/push。 [smarttube-hy2-instance-recovered-20261018]

## 21:21–21:22 真实播放恢复验收

收尾只读查询发现用户已自行进入SmartTube PlaybackActivity，于是追加60.01秒、21个样本的只读观察，未发按键或切应用。

- 实际1080p VP9解码帧843→2643，平均30帧/秒；所有采样drop/frame error/hardware error均0。
- 同7条真实googlevideo连接累计新增15467034字节，实际链路始终hy2→auto；不是临时正文探针流量。
- 所有样本MediaSession state=3，未捕获state=6；本窗口SmartTube异常关键词日志0条。采样不能排除3秒间隔内短暂缓冲，也不能保证所有视频长期流畅。
- MediaSession position及buffered position没有逐帧更新，未将其固定值当停播证据；实际帧计数和媒体下载提供独立进展证据。

结论更新：当前“彻底连不上”已恢复，并已观察SmartTube真实播放；长期HY2会话失效/偶发卡顿风险仍在。证据recovery-samples.jsonl、recovery-app-events.jsonl、playback-recovery-summary.json；采样结束后专用ADB转发已清。 [smarttube-hy2-playback-recovered-20261018]
