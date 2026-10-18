# Netflix CDN watchdog

2026-10-18 已部署，运行接线与验收见 [DEPLOYED.md](DEPLOYED.md)。构建脚本只构建，不自动安装。

仅在 Netflix `com.netflix.mediaclient/.ui.player.PlayerActivity` 精确位于
`mResumedActivity` 时，通过专用本机 SOCKS 做一次 256 KiB HTTPS 下载。
探针使用系统 TLS 信任库与 HTTPS 主机名验证，不使用自签信任或关闭验证。
原始 SOCKS/TLS socket 每次只连接和请求一次，没有 HTTP 客户端透明重试。

默认每 30 秒检查一次；连接、读取分别 6 秒；整个探针 12 秒硬截止，超时
关闭 socket 并 interrupt 工作线程。非播放器前台不发探针。

默认选择器 `zgo-video`：HY2 连续两次失败后切 Reality；在 Reality 期间仍
通过固定 HY2 的 SOCKS 探测 HY2，连续三次成功且至少保持 180 秒才回 HY2。
PUT 之后必须独立 GET 验证 `now`。
仅当故障回退已验证成功，才删除 chains 同时包含选择器与旧 HY2 节点的
连接，删除后重新 GET 确认目标 ID 已消失。PUT/验证/清连接遇到临时错误时
保留本进程内 pending；后续播放器活动周期先独立 GET 确认 Reality，再重试
精确清连接。恢复 HY2 不断开已有 Reality 连接。

下一次前台检查确认离开播放器或检查失败时，清除连续失败/成功计数，避免
已观察到的两次观看跨段累积；两次检查间短暂离开再进入无法观察到。
Reality 最短保持期仍按已经验证切换的时刻计算。默认前台检测每 30 秒一次，
单次 `dumpsys activity activities` 最多 4 秒、输出最多 1 MiB，非持续轮询。

**边界：** 这只是小 GET 的通道存活检查，不是 Netflix 视频负载、其 CDN、
授权、DRM 或持续吞吐的完整保证。HY2 小 GET 成功不等于完整视频流一定健康。

`interrupt_existing_connections=false` 必须由部署者在 sing-box 选择器
配置中设置；Clash REST API 没有此设置，守护程序不修改代理配置。
专用 SOCKS `127.0.0.1:1081` **必须固定路由到 zgo-hy2，不能经 zgo-video
选择器**；无论当前 Netflix 选择哪条线路，探针均检测 HY2。程序不能凭端口
判断路由是否配置正确，部署验收须独立核查运行时链路。

运行配置示例见 `config.example.json`。Bearer 仅从 `secret_file` 读取，要求
绝对路径、普通非软链接文件、权限严格 0600；不通过命令行传值、不写日志。
API 固定连接 `127.0.0.1`，仅端口可配，不使用环境代理。

构建：`./build.sh`，产物 `watchdog.dex`。不调用 ADB、不安装、不改生产配置。
设备运行方式：`CLASSPATH=/path/watchdog.dex app_process /system/bin NetflixCdnWatchdog /path/config.json`。
路径只是示例，部署者应按实际设备目录调整。

状态 JSON 原子写入 `state_file`（默认配置目录的 `watchdog-state.json`），
包含 pid、lastProbe、failures、successes、selected、lastVerifiedSelection、
lastSelectionVerifiedAt、selectedSince、前台状态和最后探针结果。`selected`
与 `lastVerifiedSelection` 仅在真实 GET 成功后更新；API 失败保留最后证据，
并在 `errorType` 标明失败。停止后 pid 应由调用方与 `/proc` 独立核查。
`pendingHy2Cleanup`、`lastCleanupDeleted` 与 `lastCleanupError` 分别记录待重试、
独立查证已经消失的连接数量和清理错误；零匹配日志为 `cleanup_no_matches`。

日志每行只包含时间、probe、bytes、elapsed、selected、errorType；没有 URL、
query、邮件、Authorization 或凭据。诊断异常仅记类型，不输出 message/stack。

隔离验证：`./test.sh`（纯 JVM、内存 HTTP 样本与回环模拟 SOCKS，不触设备）。
`./test-api.sh` 使用回环 HTTP fixture 调真实生产 switch/cleanup 方法，覆盖
独立 GET、错误 now、API 失败、精确清理、DELETE 假成功及后续重试。测试专用
JSON jar 在 `build/test-deps/`，来源/哈希见 `SOURCE.txt`，不打包入生产 Dex。


## 可重现测试依赖

JVM API测试使用 `org.json:json:20240303`；生产Dex只用Android自带JSON。以下依赖存build中，不提交仓库。test.sh每次新建临时证书目录，结束清理，避免旧一天有效期证书导致隔日误报。

```bash
python3 - <<'PYDEPS'
from pathlib import Path
from urllib.request import urlopen
from hashlib import sha256
url = "https://repo.maven.apache.org/maven2/org/json/json/20240303/json-20240303.jar"
data = urlopen(url, timeout=30).read()
assert sha256(data).hexdigest() == "3cf6cd6892e32e2b4c1c39e0f52f5248a2f5b37646fdfbb79a66b46b618414ed"
p = Path("build/test-deps/json-20240303.jar")
p.parent.mkdir(parents=True, exist_ok=True)
p.write_bytes(data)
p.chmod(0o600)
PYDEPS
./build.sh
./test.sh
./test-api.sh
```

实际电视接线、故障测试与回退见 DEPLOYED.md。
