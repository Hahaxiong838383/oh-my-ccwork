# Worker 监控修复与验收（2026-11-05）

## 现役主机真值

用户已确认 `64.90.13.117` 销毁。生产 worker 仅 `64.90.13.177`（voice-worker-hk2）；旧地址不能继续采集，也不能通过更新主机指纹恢复连接。API 的 `WORKER_STATS_SSH_TARGETS` 仅保留 hk2，热词通道原本已经指向 hk2。

## 根因与修复

旧机故障为已销毁资产仍留在采集配置；新机并未离线。原脚本重复扫描历史 journal，实测整个SSH采集18–19秒，超过API的12秒预算。2.5GB journal上，即使添加事件过滤，45小时连接事件仍需6.426秒，24小时命令统计需4.236秒。

- 普通采集只读实时资源、systemd、边车进程/套接字、TLS和历史统计缓存，不再执行journalctl；总预算7.5秒，超时清理子进程组并返回已有字段。
- `p003-host-journal-cache.timer`每60秒触发独立只读oneshot；刷新总预算40秒、单journal命令15秒、systemd45秒兜底，flock防重叠。
- 缓存位于`/run/p003-host-monitor/cache.json`，0600/root，原子替换，仅保存统计与必要元信息，不保存孩子原话；180秒过期。缓存失败、缺失、过期、PID/进程启动时间不匹配均显示未确认，不能回落为健康或零事件。
- 两个后台接口共用按目标缓存和执行中任务：成功30秒，失败/部分失败5秒。刷新不会叠加SSH扫描。
- 页面区分采集结果与服务状态；显示历史统计更新时间。整体请求失败明确标记上次结果，并隐藏旧容量。SSH错误过滤装饰边框，保留真实原因。

## 日常检查

```sh
systemctl status p003-host-journal-cache.timer p003-host-journal-cache.service
systemctl list-timers p003-host-journal-cache.timer
journalctl -u p003-host-journal-cache.service --since=-10min --no-pager
```

手动刷新使用`systemctl start p003-host-journal-cache.service`，不要绕过服务锁。独立执行必须使用同一把`/run/p003-host-monitor/refresh.lock`。不要重启语音worker来修监控。

验收必须同时查看`/api/admin/hosts-status`和`/api/admin/worker-stats`：仅三张主机卡（API、hk2、信令），仅一个worker目标；实时采集与日志缓存状态分别正常；接入容量有有效数字；两个接口共享同一worker快照。

## 回归检查

- `NODE_OPTIONS=--experimental-sqlite node_modules/.bin/tsx scripts/hosts-status.test.ts`；本地旧分支缺生产路由依赖时可用`HOSTS_STATUS_UNIT_ONLY=1`跑采集层，发布前仍需在生产依赖隔离副本跑完整测试。
- `python3 ops/test_host_stats.py`：超时、进程清理、错误语义、缓存代次与过期、刷新失败和隐私最小化。
- `apps/web/scripts/monitor-ui.test.cjs`：真实完整Vue模板的浏览器fixture，覆盖失败、未知、陈旧容量与缓存时间。复用已有Playwright，按脚本注释指定模块/浏览器路径。

## 部署与回滚约束

只发布本次核对过SHA的采集脚本、聚合模块、设备卡缓存入口、admin HTML和两个新增监控unit。保留生产worker三服务PID/重启计数作为保护锚。API需要一次定向重启加载代码和目标配置，语音worker无需重启。

回滚代码只恢复本轮备份的对应文件；**保留hk2单机目标，不得整份还原旧.env导致已销毁地址复活**。回滚worker脚本前先停新增timer/service，避免旧脚本不支持刷新参数。备份路径、提交和最终实测值见下方发布回执。

## 发布回执

待真实预热、连续采集、生产接口及页面验收后补齐。
