# Horizon AI 精选接入

## 定位

Horizon 只负责生成“每日 AI 精选”，不进入实时资讯缓存，不改写 theory-radar 报告，也不替换 GitHub 风向标。

- 实时流：`aihot + yuweiwan + 5000 条热层/冷归档`，保持原链路。
- 理论雷达：`arXiv RSS + OpenAlex + Grok`，保持原链路。
- Horizon：精选国际技术社区、官方博客和开源动态，生成 4-12 条结构化解读。

## 数据流

1. 固定 commit 的 Horizon 在独立 oneshot 任务中运行。
2. MCP pipeline 保存 `raw/scored/filtered/enriched` 阶段产物。
3. `runner.py` 将 enriched items 映射为个人站契约并执行发布门禁。
4. 发布前按 URL 剔除已经存在于实时流缓存的条目，确保精选层提供增量价值。
5. `PUBLISH=false` 时只写 `data/radar-horizon/shadow/`，页面不可见。
6. `PUBLISH=true` 时原子写入 `data/radar-horizon/report-YYYY-MM-DD.json`。
7. 页面只有在 `RADAR_HORIZON_VISIBLE=true` 时读取正式报告。

## 安全边界

- API key、Webhook token 仅存 `/etc/horizon-radar.env`，权限 `600`。
- Runner 状态不写 key、prompt、原始模型响应或 webhook URL。
- Webhook 对正文做长度、URL、条数、分类和日期校验。
- Horizon 失败、条数不足或 webhook 失败时返回非零，不覆盖正式 last-good。
- `shadow/` 永不被页面读取。
- 韩国节点连续实测 GDELT 返回 429，首期生产配置暂时停用；保留配置项，待上游稳定后再灰度恢复。

## 部署目录

```text
/opt/horizon-radar/
  runner.py
  adapter.py
  run.sh
  config.json
  vendor/Horizon/       # 固定 commit
/var/lib/horizon-radar/
  state.json
  runs/
  candidates/
/etc/horizon-radar.env  # root:root 600
```

## 首次安装

```bash
install -d -m 755 /opt/horizon-radar/vendor /var/lib/horizon-radar
cp adapter.py runner.py run.sh inspect.sh config.example.json /opt/horizon-radar/
cp config.example.json /opt/horizon-radar/config.json

git clone https://github.com/Thysrael/Horizon.git /opt/horizon-radar/vendor/Horizon
git -C /opt/horizon-radar/vendor/Horizon checkout 1e2fdc7ccb177f33c59aef2082c4093e1e82b22c
cd /opt/horizon-radar/vendor/Horizon && uv sync --frozen

cp env.example /etc/horizon-radar.env
chmod 600 /etc/horizon-radar.env
cp horizon-radar.service horizon-radar.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now horizon-radar.timer
```

## 影子验收

保持：

```dotenv
PUBLISH=false
RADAR_HORIZON_VISIBLE=false
```

检查：

```bash
systemctl start horizon-radar.service
systemctl status horizon-radar.service --no-pager
/opt/horizon-radar/inspect.sh
find /var/www/chenchuan-site/data/radar-horizon/shadow -type f -maxdepth 1
```

至少验证：

- 任务 exit 0。
- 4-12 条精选，URL 唯一。
- 与实时流 URL 重复项已被剔除，`realtimeDuplicateCount` 可审计。
- 非 AI 高相关候选已被二次过滤，`relevanceFilteredCount` 可审计。
- `state.json` 与站点 health 均为 `ok=true`、`mode=shadow`。
- `/radar` 仍为 HTTP 200，实时流条数不缩水，理论报告不变。

## 正式切换

先备份站点 data 和 env，然后同时切两个开关：

```dotenv
# /etc/horizon-radar.env
PUBLISH=true

# /var/www/chenchuan-site/.env.local
RADAR_HORIZON_VISIBLE=true
```

重启个人站后手动运行一次 `horizon-radar.service`，检查正式 `report-*.json` 和浏览器页面。

## 回滚

```bash
systemctl disable --now horizon-radar.timer
# /var/www/chenchuan-site/.env.local -> RADAR_HORIZON_VISIBLE=false
pm2 restart chenchuan-site --update-env
```

不删除 `data/radar-horizon/`，保留正式报告、影子报告和 candidates 供审计。实时流和理论雷达无需切换或重启其生产任务。
