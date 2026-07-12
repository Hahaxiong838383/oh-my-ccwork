# iptv-api（托管配置）

私人 IPTV 运行在香港 `chenchuan-site:/opt/stacks/iptv-api`。

## 播放策略（2026-07-12）

- **默认全部源站直连**（Televizo 实测港跳双跳更卡）。
- 港跳脚本：`scripts/hls-proxy.py` / `rewrite-m3u-via-proxy.py`；`proxy/config.json` 中 `proxy_groups=[]` 即关闭改写。
- 发布：`result.origin.m3u` 为源；`result.m3u` 为播放器列表。
- 变更日志（服务器）：`/opt/stacks/iptv-api/logs/CHANGELOG-2026-07-12-hls-proxy.md`

Secret（私人 M3U token）不入本仓。
