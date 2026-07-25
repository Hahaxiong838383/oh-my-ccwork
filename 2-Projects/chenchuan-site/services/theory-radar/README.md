# Theory Radar Service

韩国节点上的 AI 前沿理论雷达独立任务。它不修改个人站进程，只通过现有 loopback webhook 发布通过门禁的报告。

## 数据链路

1. 每日读取六个 arXiv 官方分类 RSS。
2. OpenAlex 按稳定 Author ID 补充六位专家的 arXiv 论文。
3. 本地去重、确定性相关度排序，最多选择 8 篇。
4. Grok 4.5 使用 strict JSON Schema 批量分析。
5. 校验日期、数量、ID、URL 和字段后才允许发布。
6. arXiv Query API 仅在周度对账时做一次探测；429 会熔断 6 小时，不阻塞日报。

## 运行模式

- `PUBLISH=false`：影子运行，只写 `/var/lib/theory-radar/reports/`，不触碰个人站数据。
- `PUBLISH=true`：POST `127.0.0.1:3000/api/radar-webhook`；失败不会覆盖站点已有报告。

```bash
python -m unittest discover -s tests -v
docker build -t theory-radar:2.0 .
docker run --rm --env-file /etc/theory-radar.env \
  -v /var/lib/theory-radar:/var/lib/theory-radar theory-radar:2.0 run
```

## 运维命令

```bash
systemctl start theory-radar.service
systemctl status theory-radar.service
journalctl -u theory-radar.service -n 100 --no-pager
docker run --rm --env-file /etc/theory-radar.env \
  -v /var/lib/theory-radar:/var/lib/theory-radar theory-radar:2.0 health
```

`retry-analysis` 复用当天候选快照，不再次访问上游；`reconcile` 执行完整任务并探测 Query API 熔断状态。

## 安全与回滚

- `/etc/theory-radar.env` 必须为 `root:root 600`，secret 不进入 Git 或日志。
- 容器只读、非 root，限制为 0.5 CPU、384 MiB 内存。
- 切换前先做一次 `PUBLISH=false` 影子 smoke；通过后切 `PUBLISH=true` 并停用 Mini，生产观察 3 天。
- 回滚只需停用韩国 timer；个人站进程和历史报告不需要重启或删除。
