# YouTube / SmartTube 四级故障守护

2026-10-18 22:37更新：用户授权后已启用。运行配置的DNS身份已改为与生产DoT一致的`1.1.1.1`，保留严格TLS IP SAN校验；下文初次开发阶段记录中的“未激活”状态仅为历史，当前状态以README为准。

源码复用来源：`/home/hahaxiong83/home-lan/4-Assets/Code/netflix-cdn-watchdog/NetflixCdnWatchdog.java` 的完整 HTTP framing、TLS 域名校验、操作 deadline、受保护 secret 读取与原子状态落盘机制。实现与回环测试先在 `/tmp` 完成，再归档到本目录。初次开发阶段（22:14）DEX 仅上传 inactive stage 并执行配置/加载检查，当时未启用；之后用户授权发布，当前状态以本目录 README 为准。

## 接口

- `YoutubeFailover CONFIG`：守护循环。默认 `dry_run=true`，只读API/网络探针和本地状态落盘，禁止任何 PUT、DELETE、worker restart。
- `YoutubeFailover --check-config CONFIG`：仅加载配置、读取 secret 校验权限、读取 boot/release/授权 marker。打印候选数、valid、authorized、各 marker 权限状态。不写 state，不启动进程，不进行 API 或网络调用。即使 dry_run=true 也独立检查 marker 的 NIO 权限路径，不靠布尔短路冒充验证。
- `YoutubeFailover --worker-safe CONFIG rack|zgo`：只读API，必须授权门通过；当前 selector 不得选择对应 HY2，任何连接的 chains 均不得包含对应 worker tag。错误一律退出非0，适合 workerctl 在发送信号前再次独立检查。

调用形式：`CLASSPATH=/data/adb/video-proxy/youtube-failover/guard.dex /system/bin/app_process /system/bin YoutubeFailover ...`。本地构建输出叫 `youtube-guard.dex`，暂存时可命名 `guard.dex`。

配置完整字段见 `config.example.json`；secret 只存路径，不允许明文写入配置或日志。Reality 候选不写 worker 字段。candidate 顺序、tag、worker 绑定严格验证。

## 行为

1. 视频 selector 是 `youtube-video`；固定探针 SOCKS 19101..19104 对应 `yt-rack-hy2 → yt-rack-reality → yt-zgo-reality → yt-zgo-hy2`，经过主进程固定路由再进入独立 HY2 worker，不绕过主进程直接探 worker。
2. 视频检测条件是实际 resumed activity 属于 SmartTube beta/stable/smarttubetv 或官方 YouTube TV，或者 live connections 的 chains 含 youtube-video。不会打开、切换或操作 App。
3. 每个候选并行请求 `speed.cloudflare.com` 的精确256KiB完整正文及 `www.youtube.com/` 的完整正文（4096字节至2MiB、HTTP200、identity编码、有 ytInitialData）。每条完整网络操作12秒硬 deadline，覆盖SOCKS、TLS、头和全部正文，超时关闭底层 socket。不会跟随重定向或禁用TLS校验。
4. 当前失败后等2秒，第二轮并行检查全部候选。候选健康证据必须属于本轮及对应tag。所有主站探针都坏但部分YouTube完整正文有效时，标记主探针站不可用，并使用该轮YouTube正文证据：当前有效则保留；当前也无效且其他候选有效才转移。全部不可用时不推测切换、不重启。
5. 切换是独立 GET → PUT → GET；失败迁移在确认新目标后才删除 chains 同时包含 selector 和旧tag 的连接，随后独立 GET 确认：已删ID消失且没有任何迟到的旧链连接。失败保持 pending 意图并稍后重试。正常恢复不删除旧健康连接。
6. 恢复每60秒检查高优先级候选，同一维护轮也检查所有未被选中的HY2 worker（包含当前首位健康时的末位ZGO），连续3轮成功且当前选择已保持300秒才恢复。非活动会话或进程重启会清掉成功连续计数。
7. 独立 worker 只调用 `sh workerctl.sh restart rack|zgo`。失败迁移完成清理后，或已确认当前路健康而任何未选中worker双目标均失败时，安排有限自愈。重启前重新确认当前路可用、故障worker仍坏、selector已离开该worker且任何链都没有该worker流量。仅主探针站坏而YouTube正文正常时不重启。
8. 重启等待1分钟，后续3/10分钟退避，滚动15分钟最多3次，第三次后30分钟冷却。尝试在调用前落盘，超时/失败也计入。状态绑定boot_id，同一boot内进程重建不清预算。重启后恢复成功计数归零。主 sing-box 不会被该守护重启。
9. DNS selector `dns-uplink` 独立检测；固定SOCKS19111/19112对应两条Reality。直接向数值IP1.1.1.1:853发真实DoT请求，使用生产DoT的TLS身份（当前1.1.1.1，严格校验IP SAN；若生产显式server_name则沿用），不借助当前故障DNS。验证DNS ID、question、QR/opcode/rcode/TC、压缩名字/CNAME和有效A答案。候选DoT成功后GET→PUT→GET；这证明候选DoT可用及selector改变，**没有声称生产5354缓存应答来自新上游**。

## 授权、状态与开销

每次 PUT/DELETE 和重启调用前均核 `dry_run=false`、enabled内容等于release-id、authorized-boot-id等于当前boot。三个marker必须为0600普通文件、拒绝符号链接。workerctl还会独立重复安全门。首次安装、stage与check-config不生成授权文件。

状态只含策略、boot_id、错误类型和预算，0600写临时文件、fsync、原子rename。启动读到损坏状态会失败关闭，不自作主张抹掉预算。部署器必须保证只有一个守护主循环实例；worker-safe/check-config是独立只读进程，不争用循环状态。

当前实现每30秒对活动中的当前lane执行双目标。按上限计算 `(256KiB + 2MiB) × 120 = 270MiB/小时` 正文；实际YouTube正文通常低于2MiB。恢复候选、每60秒未选中worker维护、故障复核、重启前确认会增加流量，DNS还有少量DoT开销。这不是30MiB/小时方案。当前已激活，视频按前台/存量连接条件巡检，DNS独立运行。

## 构建和测试

`build.sh` 仅使用已有JDK21、SDK34、D8生成DEX；`test.sh` 使用已有netflix watchdog的JSON测试jar，不下载依赖。可设 `TASK_BUILD_DIR=/tmp/...` 把构建目录外置。

测试包含：真实回环 SOCKS→TLS→HTTP 完整body、错误域名/不可信证书/超时取消；真实回环DoT正例和错误ID；真实HTTP API错误/错误读回/假DELETE204/迟到连接/丢失验证恢复；dry-run、缺marker、错release/boot、权限0644与symlink；恢复保持旧流；预算落JSON后重建guard实例仍受退避/冷却限制；boot时从未选中的Rack或末位ZGO坏worker能有限自愈（含当前首位健康场景），当前fallback也坏时禁止重启。

当前实网已通过四lane完整正文、两HY2非DNS公网UDP、两DoT、同UID TUN正文及备用ZGO worker自动重建；仍未完成SmartTube实际媒体故障切换、Netflix实播回归、新版本冷启动与长期稳定性。具体证据和边界以README及实施报告为准。
