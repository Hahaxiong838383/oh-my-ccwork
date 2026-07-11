# IPTV AI Ops 部署方案

## 目标

在个人站生产服务器 `aliyun-kr` 部署 `Guovin/iptv-api`，每日自动聚合经过实时验证且具备合法使用依据的直播源，输出私人 M3U，并接入 AI Ops、n8n、Uptime Kuma 和飞书闭环。

## P0 架构

```text
合法公开/自有 M3U 来源
  -> Guovin/iptv-api 聚合、别名、测速、过滤
  -> 原子发布 result.m3u
  -> 私人高熵路径交付播放器
  -> n8n 每日验收
  -> Kuma/飞书/AI 待办/恢复闭环
```

第一版只部署 `Guovin/iptv-api`，不部署 `M3Undle`、`iptv-m3u-manager` 或 IPTV 视频代理；关闭 RTMP/HLS 推流，服务器仅提供 M3U、EPG 与脱敏状态，避免承担频道视频流量。

## 安全边界

- 独立目录 `/opt/stacks/iptv-api`，不进入 `/var/www/chenchuan-site`。
- 容器服务只监听 `127.0.0.1`，由 Nginx/Caddy 提供 HTTPS。
- M3U 使用可轮换的高熵私有路径；路径 token、Webhook、Kuma Push URL、私人源和账号不进入 git、文档、记忆、Grok 输出或飞书。
- AI Ops 只读快照采用文件级 allowlist；禁止 `.env`、secrets、完整 M3U、日志正文和数据卷。
- 生产维护使用独立限权通道，只允许 `inspect`、`refresh`、`restart-iptv`、`rollback-last-good`，禁止任意 shell。
- 仅使用自有、明确授权或具备合法公开播放依据的频道源。

## 运行策略

- 每日 `02:10 Asia/Shanghai` 聚合更新。
- 初始关闭自动永久停用来源，避免单次网络抖动误伤。
- 每个标准频道保留一个最优结果，按稳定速率、延迟、分辨率排序。
- 新结果先写临时文件；格式、数量、关键频道、重复和抽样播放验收通过后再原子发布。
- 保存最近 7 个合格快照；失败继续提供 `last-good`。
- 服务器测速只能代表韩国节点；后续增加家庭网络观察点校正真实播放质量。

## AI Ops 闭环

- n8n 在每日更新后检查容器、M3U 格式、更新时间、频道数量、标准频道重复和抽样播放。
- Kuma 监控私人 M3U 健康端点与每日 Push 心跳，绑定飞书运维告警。
- 失败时不覆盖合格版本，自动创建脱敏待办并告警；恢复后自动关闭待办并发恢复通知。
- 有限抽样只能输出“就绪度”和探测通过数，不宣称全部频道业务健康。

## 验收

1. 容器重建后配置和结果仍存在。
2. 私人 M3U 返回 `200` 且以 `#EXTM3U` 开头；错误路径返回 `403/404`。
3. 标准频道重复数为 0，关键频道存在，抽样流由 FFmpeg/ffprobe 真实读取视频流。
4. 故障更新不覆盖 `last-good`；Kuma/飞书完成 Down/Up 闭环。
5. `chenchuan-site` PM2 online、公网探测 `6/6`。
6. AI Ops 全量回归输出 `OK vibe regression`。
7. 川哥用播放器实际测试至少 5 个频道后完成最终验收。

## 回滚

- 停止 IPTV 新容器。
- 恢复 Nginx/Caddy 备份和 `last-good` M3U。
- 清理本轮测试监控，不碰个人站原有文件、数据库和媒体。
- 重新验证个人站 PM2 和公网 `6/6`。
