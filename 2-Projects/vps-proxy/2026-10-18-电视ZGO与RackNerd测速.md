# 电视盒 ZGO 与 RackNerd 测速：2026-10-18

结论：本轮两者下载接近，ZGO 中位数略高；RackNerd HY2 的请求响应更快、上传较高。Netflix 已由用户确认登录成功，继续使用现有 ZGO 路线。测速结束后已清理临时实例，实际现网 PID 与配置 SHA256 均未变化。

## 实测结果

电视本机，单连接 HTTPS；下载每次 20,000,000 字节，上传每次 10,000,000 字节；各三轮轮换顺序，中位数，括号为最小–最大值。速率单位 Mbps，按完整请求总时间计算，包含建连与响应开销。

| 路线 | 下载 Mbps | 上传 Mbps | HTTPS 响应头耗时 | Cloudflare 节点 |
|---|---:|---:|---:|---|
| ZGO-Reality | 18.0（16.4–20.3） | 28.2（23.4–29.7） | 960 ms | LAX |
| RackNerd-HY2 | 16.2（16.0–16.8） | 31.0（30.4–31.0） | 572 ms | SJC |
| RackNerd-Reality | 17.1（13.6–18.7） | 23.8（6.8–25.4） | 1103 ms | SJC |

- ZGO：真实出口 38.49.38.237，VLESS Reality 直连 11447。
- RackNerd：真实出口 23.226.135.149；HY2 36712、Reality 2443 分开测，没有将两个协议混成一个结果。
- **现有 HY2 配置为 down_mbps=18、up_mbps=40。** 下载已接近这项配置上限，本次没有解除它，不能将 16.2 Mbps 当成 RackNerd 服务器的最高速度。同为 Reality 的路线对照为 ZGO 18.0、RackNerd 17.1 Mbps，三个样本范围明显重叠。
- ZGO 和 RackNerd 分别命中 LAX/SJC，是当前完整路线的实际表现，并非相同 CDN 机房的纯 VPS 带宽对照。
- HTTPS 响应耗时来自独立 1KB 小请求，包含代理与 TLS 建连和服务端响应，不能当 ICMP ping。此测试也不是 Netflix 视频 CDN 测试，不能据此承诺全天持续速率。

## 方法与有效性

临时 sing-box 仅提供三个电视回环 SOCKS 入口，无 TUN、无自动选择/回落。每个出口的 DNS 单独经对应节点。先核真实公网 IP，再测同一 `speed.cloudflare.com` 的 __down / __up。Java HTTPS 程序在电视本机运行：正文由电视读取/发送，ADB 仅传回统计，避免把正文搬回开发机导致 ADB/LAN 限速混入结果。程序使用 64KiB 缓冲、identity 禁压缩、固定长度上传和单调时钟；不关闭证书验证。

测试前媒体会话 `com.netflix.mediaclient active=false`，未操作电视 UI；一次负载采样中，测速 sing-box/Java CPU 分别为7.9%/11.5%，该采样未见单核打满，不外推整个测试窗口。主流程 33/33 样本、补充上传 9/9 样本均通过 HTTP200 和字节判据，没有超时。下载每次精确 20MB，上传写完固定长度并收到服务器 HTTP200。

初始 2MB 上传仅约 1–3 秒，连接开销占比明显，因此额外使用 10MB 上传三轮，**两种尺寸分别统计**。2MB 中位数为 ZGO 5.3、HY2 16.9、Rack Reality 6.7 Mbps，不能把这组当持续带宽或与10MB样本混算。Rack Reality 10MB 上传有一次 6.8 Mbps，其余23.8/25.4，波动已在表内保留。

## 清理与证据

临时进程 PID29547 已按核实的配置路径准确退出，三个 ADB forward、设备临时配置/Dex/日志均移除；本机含凭据的测速配置也已删除。原生产 PID23086 与配置 SHA256 `ce1c6a46a12cd3793ddb8f395bcdf73fe74db59d1a17b4f60a8c2e44aa194c2d` 均独立复核不变。

证据目录 `/tmp/netflix-speed-20261018/`：`samples.jsonl`、`large-upload.jsonl`、`summary.json`、`route-log.txt`、`cleanup-verification.json`；程序 `TvSpeedProbe.java` 与调度脚本保留，无账号凭据。未修改 APK/账号/现网代理配置，未 commit。

署名：codex（OpenAI）| 2026-10-18 10:30 CST
