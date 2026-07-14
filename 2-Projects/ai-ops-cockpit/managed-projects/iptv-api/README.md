# iptv-api（托管配置）

私人 IPTV 运行在香港 `chenchuan-site:/opt/stacks/iptv-api`。

## 播放策略（2026-07-12）

- **默认全部源站直连**（Televizo 实测港跳双跳更卡）。
- 港跳脚本：`scripts/hls-proxy.py` / `rewrite-m3u-via-proxy.py`；`proxy/config.json` 中 `proxy_groups=[]` 即关闭改写。
- 发布：`result.origin.m3u` 为源；`result.m3u` 为播放器列表。
- 调度：容器 02:10 产出 candidate，`iptv-validate-publish.timer` 每日 02:25 执行校验、抽样、原子发布；`flock` 防止并发，失败保留 last-good。
- 安装/修复定时器：`sudo scripts/install-validate-publish-timer.sh --run-now`。
- 变更日志（服务器）：`/opt/stacks/iptv-api/logs/CHANGELOG-2026-07-12-hls-proxy.md`

Secret（私人 M3U token）不入本仓。
