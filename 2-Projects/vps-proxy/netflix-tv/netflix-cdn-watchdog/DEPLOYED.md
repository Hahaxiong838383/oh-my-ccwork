# 电视实际部署（2026-10-18）

设备：X96 X10Pro，Android 11，ADB 192.168.1.144:5555。主代理程序 sing-box 1.14.3。

- 运行目录 `/data/adb/video-proxy/`；配置 `watchdog-config.json`，程序 `watchdog.dex`，状态 `watchdog-state.json`，日志 `watchdog.log`。
- 开机入口 `/data/adb/service.d/netflix-cdn-watchdog.sh`，用 BusyBox flock **文件路径模式**持有单实例锁，再运行 `watchdog-run.sh`。此固件的 sh 下用单独数字 FD 模式实测报 Bad file descriptor，勿改回。
- 入口重复启动实测只有一个 app_process；PID 文件 `watchdog.pid`，状态 PID 必须再与 `/proc/PID/cmdline` 核对。
- `watchdog-disabled` 文件存在则不开启；回滚脚本先设置它再精确停止该 Java 进程。
- 只在 Netflix PlayerActivity 前台探测；固定 SOCKS `127.0.0.1:1081` 直接走 ZGO HY2，不能经视频selector，否则会把Reality健康误当HY2恢复。
- 30秒一次，256KiB真实HTTPS下行，最大12秒；2次失败转Reality，3次成功且保持Reality至少180秒恢复HY2。离开播放器清连续计数。
- Clash API `127.0.0.1:19090`；凭据在Vault条目「Netflix 电视分流本机管理」，只存在受保护配置/secret文件，勿打印配置。
- selector `zgo-video`：`zgo-hy2` / `zgo-netflix`，默认HY2，`interrupt_exist_connections=false`。sniff前后均配置 `tun-in + nflxvideo.net` 媒体规则，DNS reverse_mapping开启，DNS仍走Reality。
- 无域名识别的连接安全落Reality；reverse_mapping受TTL/1024项缓存/共享IP影响，不保证所有媒体连接被识别。

## 回退

通过ADB运行 `sh /data/adb/video-proxy/rollback-hybrid.sh`：停止/禁用watchdog、恢复混合分流前配置及开机脚本，然后重启原代理。备份目录 `backup-20261018-hybrid` 含凭据，权限700/600，不复制进仓库。

APK适配独立运行，网络回退不卸载APP也不清Netflix数据。若要停遥控适配，禁用 `cn.hahaxiong.netflixremote`，不要禁用Netflix。

## 已完成验证

- 配置check通过；运行API选中HY2。
- Netflix真实视频连接 `nflxvideo.net` 的chains含 `zgo-hy2,zgo-video`，已观察25MB以上视频下行；账号/API连接仅含 `zgo-netflix`。
- 真机仅临时拒绝本机1081探针端口，两次失败后自动回Reality，精确关闭两条旧HY2媒体连接；其余控制连接保留，新媒体链为 `zgo-netflix,zgo-video`。测试规则已移除且有90秒自动清理保护。
- 小探针仅证明HY2至Cloudflare下行存活，不保证Netflix授权、DRM、各CDN或长期吞吐；未将早前大上传reset宣称为修复。
- Java isolated tests：33项传输/策略＋41项真实切换/清连接方法HTTP测试。

11:28:05真机自动恢复已验证：HY2连续3次完整262144字节下载成功且Reality保持期超过180秒，独立API回读now=zgo-hy2；两条旧Reality视频连接保留。Netflix重启后新视频连接重新走HY2并实收20MB以上；控制接口继续Reality。故障注入iptables已清、试运行pending标记已清。源码不含实际节点密码或API secret。
