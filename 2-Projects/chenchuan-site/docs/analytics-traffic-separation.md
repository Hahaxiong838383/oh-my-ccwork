# 访问统计流量拆分与回滚

## 目标

- `/admin` 只展示真实浏览器完成页面加载后的 PV / UV。
- `/admin/system-traffic` 单独展示站长调试、AI Ops / Kuma、预加载、机器人和扫描器。
- curl、健康检查、Next.js prefetch、非法路径不再污染真实趋势与 Top 榜。

## 统计链路

1. `AnalyticsTracker` 在页面 hydration 和真实客户端路由切换后上报 `source=client`。
2. middleware 不再记录普通浏览器 GET，只记录能明确分类的系统流量。
3. `/api/track` 使用请求头获取客户端 IP / UA，并用后台会话、环境变量、UA、路径和 prefetch header 分类。
4. `visits.traffic_kind` 取值：`human`、`owner`、`aiops`、`prefetch`、`bot`、`legacy`。
5. 新 schema 首次启动时回填旧记录；同 IP + UA 在 3 秒内突发至少 3 个不同页面时，除第一条外归为历史预加载。
6. 旧表没有 hydration 证据，伪装浏览器 UA 的扫描器与真人无法可靠区分，因此其余旧浏览器记录保守归入 `legacy / 历史未验证`，不进入真实 PV / UV。

## 生产配置

生产 env 必须设置：

- `ANALYTICS_INTERNAL_TOKEN`：middleware 内部写入令牌。
- `ANALYTICS_OWNER_IPS`：站长调试出口，逗号或空格分隔。
- `ANALYTICS_AIOPS_IPS`：AI Ops、Kuma、维护节点出口，逗号或空格分隔。

真实地址只放服务器 env，不进入 Git、文档、日志或记忆。

## 部署前备份

在生产目录执行，时间戳目录整体保留：

```bash
stamp=$(date +%Y%m%d-%H%M%S)
backup="/var/backups/chenchuan-site/analytics-traffic-$stamp"
mkdir -p "$backup"
cp -a data/analytics.db* "$backup/"
git rev-parse HEAD > "$backup/source-head.txt"
pm2 describe chenchuan-site > "$backup/pm2-before.txt"
```

SQLite 使用 WAL，生产备份优先在短暂停写或 PM2 reload 前完成；若进程持续写入，应使用 `sqlite3 data/analytics.db ".backup '$backup/analytics.db'"` 生成一致性副本。

## 验收

- 普通浏览器打开页面：`human` 增加 1，系统流量不增加。
- 浏览器预加载：`prefetch` 增加，`human` 不增加。
- 已登录管理员浏览公开页面：`owner` 增加，`human` 不增加。
- Kuma / AI Ops / 健康检查：`aiops` 增加，`human` 不增加。
- curl 与扫描路径：进入 `bot` 或配置 IP 对应类别，`human` 不增加。
- `/admin`、`/admin/system-traffic`、首页均能正常打开，PM2 无持续报错。

## 回滚

1. 停止或 reload 前先保存故障现场日志。
2. 将代码切回 `source-head.txt` 记录的提交。
3. 停止 `chenchuan-site`，用备份中的一致性数据库替换 `data/analytics.db`，同时清理新 WAL / SHM。
4. 恢复原 env 后启动 PM2。
5. 验证首页、`/admin`、`/api/track` 和 PM2 状态。

旧代码不认识新增列，但 SQLite 允许保留额外列；若只回滚代码可继续运行。若要完全回到迁移前统计结果，必须同时恢复备份数据库。
