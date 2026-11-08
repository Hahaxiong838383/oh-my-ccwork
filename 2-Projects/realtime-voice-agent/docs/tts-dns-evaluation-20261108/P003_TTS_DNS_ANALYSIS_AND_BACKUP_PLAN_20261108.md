# P003 TTS DNS 分析与备用方案

**结论：已验证修复已部署。TTS 的慢解析发生在云端 Worker 发起供应商连接这一侧，不是安卓在解析 TTS 域名。可以替换 DNS，但本轮实测不支持换成阿里或腾讯；现有 Google＋Cloudflare 应保留，优先补“程序内独立备用解析”，不要把新增一个系统 FallbackDNS 当成快速容灾。**

## 1. 部署真值与范围

11 月 8 日 11:26（北京时间）读取服务器实际进程：主池仍为运行源码 `e9806c7f` 对应二进制 `057f1972…`、PID 3606030；倾听池二进制 `636b1c3d…`、PID 3593294。均 active、NRestarts=0，与已验收发布一致。独立搜索池 `56f6878f…` 未重部署。当前没有待发布的新业务候选，不重复重启。

已上线的相关能力包括：本机正负 DNS 缓存、TTS/ASR 的独立 A/AAAA 解析、CNAME 地址提取与 TTL 修正、连接分段日志、650ms 备用连接与共享总截止。主池进程实际开启 `P003_ASYNC_DNS_V1=1` 和 `P003_TTS_CONNECT_RECOVERY_V1=1`。本轮仅做只读取证、低频 DNS 和无认证 TLS 测量，未替换上游、未清生产缓存、未改路由或设备开关。

原主池部署/回滚详见 `P003_MAIN_ASR_HANDOFF_REPAIR_RECEIPT_20261108.md`。本轮不覆盖该回执，不回退到更早版本丢失 ASR、倾听或长房修复。

## 2. 到底是哪一侧慢

当前**主池** TTS 建连路径为：

```text
云端 Worker 的 TTS 代码
  → Hickory 程序内缓存 / A、AAAA 独立查询
  → /etc/resolv.conf 中的 127.0.0.53
  → Worker 本机 systemd-resolved 缓存
  → 公共递归 DNS：8.8.8.8、1.1.1.1（本次当前选中 1.1.1.1）
  → 供应商权威 DNS / CNAME 链
  → 取到地址后才开始 TCP → TLS/WebSocket → 合成
```

安卓参与的是设备自己的 RTC/业务域名解析。它不是上述 TTS 查询的发起者；更换安卓 Wi-Fi DNS 不能直接修复这条 Worker→TTS 的解析等待。Brain 签票也不在这一段查询路径上。

历史同一次 TTS `connect_id=2` 已记录 **DNS 4704ms、TCP 51ms、TLS/WebSocket 合计 170ms**。可以确定那次 4.7 秒发生在 Worker 的 DNS 阶段，不能说成 4.7 秒 TLS 超时。该次没有保存完整查询/响应包，所以仍不能唯一确定是 Worker→递归 DNS 的网络、递归服务器/权威查询，还是解析库重试/别名链共同导致；不能直接归罪于某家公共 DNS。

另一次系统解析 6375ms 的证据针对 LiveKit 域名，是另一条请求，不能与这次 TTS 混成同一个故障。之前本机只缓存正向结果，AAAA 无地址回答反复查询上游，会放大等待；`Cache=yes` 已于 00:59 上线。当前有效配置仍包含该 drop-in，正负缓存保留。

本次读取主池 07:35 后 52 条 TTS 连接记录：50 条 connected、2 条 cancelled；50 条完成连接的 DNS 中位数 0ms、最大 186ms。两条取消不能等同超时。同期任务关闭记录包含 02000053、02000026 的真实会话，但连接日志缺少逐条房间关联，因此不强行把每个连接指标分配给某个 SN，也不把连接成功当成安卓扬声器验收通过。

## 3. 在当前 Worker 上的 DNS 对照

测量窗口 **11:28:07–11:29:05 CST**，固定 TTS 域名 `cbm01.cn-huabei-1.xf-yun.com`。每个解析器分别进行 18 次 UDP A、18 次 UDP AAAA；另各有一次 TCP A/AAAA 检查，共 190 次查询。单次 DNS 查询限制 1 秒、1 次尝试；未清缓存，因此不是“每次冷解析”，不外推长期 P95 或可用性。

| DNS | UDP A 中位数 / 最大 | UDP AAAA 中位数 / 最大 | UDP 未在本次预算内收到回答 | 判断 |
|---|---:|---:|---:|---|
| 本机 stub 127.0.0.53 | 0 / 7ms | 0 / 4ms | 0/36 | 缓存有效；不能与公网冷查询直接比优劣 |
| Google 8.8.8.8 | 3.5 / 40ms | 3 / 34ms | 0/36 | 本次最适合作为独立备用候选 |
| Cloudflare 1.1.1.1 | 3.5 / 188ms | 5 / 588ms | 0/36 | 可以保留；本次存在较长尾部 |
| 阿里 223.5.5.5 | 61.5 / 423ms | 24 / 128ms（仅17次有回答） | 1/36 | 本次没有优于现役组合，不优先替换 |
| 腾讯 119.29.29.29 | 无回答 | 无回答 | 36/36 | 当前 Worker 路径不纳入备用候选 |

AAAA 的 NOERROR/NODATA 是有效“无 IPv6 地址”结果，不是整体连接失败。本机 AAAA 响应中的 A 附加记录也不能当 AAAA 地址。TCP 单次检查中，腾讯两次仍未取得回答，阿里 AAAA 也未取得回答；这些是本次预算内观测，不等于证明供应商整体故障。

随后从各解析器重新取得 A 记录，选择其前两个地址并去重，对 5 个地址做原域名 SNI、正常证书校验的 TCP/TLS 握手：**5/5 通过**，TCP 约 50.5–57.8ms，TLS 约 93.1–140.3ms。未发 API 凭据、合成文本或音频；该结果证明这些地址当时可正确完成 TLS，不等于 TTS 业务或 Android 全链路通过。

DNSPod 官方在 8 月 17 日发布过部分运营商异常公告；本轮不可达结果仍以本机实测为准，不能认定是该公告所述事件持续至今。[DNSPod 官方公告](https://docs.dnspod.cn/notices/guan-yu-gong-gong-jie-xi-public-dnsmian-fei-fu-wu-ip-119-28-28-28yi-chang-gong-gao/)

## 4. 为什么已有两个 DNS 和备用连接，仍可能一起等

1. `voice_connect.rs` 的进程级 `OnceLock<TokioResolver>` 读取系统解析配置，当前只看见 `127.0.0.53`，没有直接把 Google 和 Cloudflare 当成两条独立路径。
2. 主池当前 650ms 备用连接仍调用相同的 `connect_warm`，使用相同 resolver/stub。它能缓解单次 TCP/TLS 或预连接等待，但不能保证绕过同一 DNS 等待。A/AAAA 并行解决地址族相互拖延，不等于多家 DNS 竞争。
3. systemd-resolved 在同一查询范围内会持续使用当前 DNS，遇到错误后再换下一个，并不是每次同时比两家的速度。配置里 Google 排在前面，也不代表当前每次先问 Google。[systemd v255 官方说明](https://raw.githubusercontent.com/systemd/systemd/v255/man/systemd-resolved.service.xml)
4. `FallbackDNS=` 只在没有其他 DNS 服务器信息时使用。现在网卡已有 8.8.8.8、1.1.1.1，单独添加 FallbackDNS 不能实现“慢了 200ms 就启用备用”。[systemd v255 配置说明](https://raw.githubusercontent.com/systemd/systemd/v255/man/resolved.conf.xml)
5. 解析库的 `timeout=1s`、`attempts=2` 不是整个 DNS 阶段严格 2 秒截止；它还有逻辑重试、内部发包/退避、别名查询等层次。真正约束整次建连的是外层共享 10 秒预算，不能靠把 1×2 相乘解释历史 4704ms。

**两池不能混写：**倾听池 `85de8fb0/636b1c3d` 已有 `P003_TTS_DNS_HEDGE_V1=1`。限定该 TTS 域名的 DNS 等待 200ms 后，它从 `/run/systemd/resolve/resolv.conf` 取最多两个非环回上游，绕过 stub 查询；这段代码尚不在主池 e980/057f。本轮未观察到倾听池新任务，不能把开关已启用说成实际备用已胜出。它的配置含义是独立查询路径，不保证与系统当前 DNS 属于不同供应商。倾听池虽也启用 recovery，200ms 的 DNS 备用仍存在；只有旧 650ms 预热连接竞争被 recovery 替代，不能把两种机制混为一谈。

## 5. 建议实施方式

**本轮建议保留现役系统 DNS，最小增量复用倾听池现有 200ms 独立 DNS 备用，在主池完成回归后发布。** 不另造一套 DNS 竞争机制，不把整份倾听二进制覆盖到主池。该方案限 TTS，影响范围比修改整台服务器的解析策略小。

| 项目 | 实施建议 | 收益与边界 |
|---|---|---|
| 正常连接 | 保留现有缓存和系统 stub | 大多数查询已有 0ms 缓存收益 |
| 备用 DNS | 复用倾听池 200ms 延迟、独立 resolver、最多两路并发和配置上游名单 | 绕过同一 stub；当前名单为 Google＋Cloudflare，本次不引入更差的第三家。不要保证供应商级完全独立 |
| 配置 | 主池补齐现有 `P003_TTS_DNS_HEDGE_V1` 开关，默认关闭；首轮复用系统已配置上游与 200ms 值 | 独立地址覆盖和可调延迟可作为后续小改动，不把它们说成当前已有后台功能 |
| 地址/缓存 | 继续验证 CNAME owner、地址族与 TTL，保留正常 TLS 主机名/证书/SNI | 不固定供应商 IP，不延长 DNS TTL，不把无关附加地址当结果 |
| 预算/退出 | 共享当前前台总截止，任一路成功即取消失败/落后任务，保留两条备用并发上限 | 不叠加第二套无限重试，不因备用增加持续泄漏 |
| 可观测性 | 同 `connect_id` 记录 resolver 路径、查询族、耗时、结果、是否备用胜出 | 能证明备用是否真正生效，不靠配置开关推测 |

如果后续要改变系统 DNS 上游，应调整 systemd-resolved/网卡的实际来源，保存并可恢复原值；不要直接覆盖托管的 `/etc/resolv.conf`。保持 stub 地址不变时，应用仍访问原 stub，其上游可改变；若改为程序直读新 nameserver 或换 resolver 构造配置，当前 OnceLock 不会热重载，需要受控重建或滚动重启。系统配置影响整机，必须同时验证 RTC、ASR、TTS；不作为本轮首选。

备用 DNS 仍依赖网络和供应商权威解析，不能保证所有长尾消失，也不能修复与 DNS 无关的播放暂停、上行静音或供应商合成慢。

解析服务地址归属已对照 [Google 官方说明](https://developers.google.com/speed/public-dns/docs/using)、[Cloudflare 官方说明](https://developers.cloudflare.com/1.1.1.1/ip-addresses/)、[阿里官方说明](https://help.aliyun.com/zh/dns/free-service-disclaimer) 和 [DNSPod 接入说明](https://docs.dnspod.com/public-dns/public-dns-guide/)。延迟与可达性判断以本次 Worker 实测为准。

## 6. 开发、验收与回滚要求

拟改动集中在 `voice_connect.rs`（移植现有独立 resolver 与对应 TTL/取消测试）、`tts_xfyun.rs`（回传实际 DNS 路径），以及部署开关和验证脚本。保持 `tts.rs` 当前 650ms 连接恢复与 10 秒共享截止，不再另加连接竞争层。实际代码由 Codex 实施，Grok 独立审查。

验收先在隔离环境覆盖：主 DNS 丢包/慢响应而备用正常、主正常不启动备用、主解析快速传输失败时的处理（现有慢查询备用不应被误当覆盖所有失败）、备用失败主仍可完成、双方失败总截止不放大、打断取消无遗留、A 正常但 AAAA 无回答、CNAME/短 TTL/TTL0、域名证书不匹配必须失败。然后在真实 Worker 对固定版本做同语料普通/ordered RTC，分别记录 DNS→TCP→TLS/WS→首 PCM，并核自然关房、无未结束任务。最后单设备同 trace 验证，不以 DNS 查询成功代替语音成功。

发布前另存当时的运行 binary/env/unit 和配置；新开关可显式关闭，回到当前已验证的连接路径。代码回滚以发布时的现役版本为锚，保留已有修复；不整树覆盖、不回灌数据库。**倾听池已有该能力；本轮主池尚未移植或发布这项增量，不把分析方案当成上线结果。**

证据：`DEPLOYMENT_AND_DNS_STATE.json`（私有 `BASELINE.json` 的脱敏状态与哈希）、`DNS_MATRIX.json`、`DNS_MATRIX_SUMMARY.json`、`TLS_CHECK.json`、`CURRENT_TTS_DNS.json`，均由当前 Worker 直接采集；`DNS_ARCHITECTURE_REVIEW.md` 为 Grok 独立源码复核。当前部署与历史 4704ms 使用各自固定发布回执，不互相代替。历史分段原记录已核 `asr-connect-evidence/ASR_CONNECT_RELEASE_TTS_DETAILS.json`，不是只复述摘要。

署名：codex（OpenAI）| 2026-11-08（北京时间）
