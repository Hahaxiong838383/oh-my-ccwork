# H 平台后续 TODO（2026-07-30 12:0x 快照）

> **线上终态**：控制面 `v1.33.1`（aliyun-hk `/srv/h-control/app`）/ 全 Bot 行为契约
> `2026-07-30.1` / bridge+runner-worker 双进程（dev198 user 级 systemd）/ dev198 git
> 已入账追平 `origin/main` = `258bcc1`。
> **实测基线**（cc 07-30 11:2x–12:0x 亲验）：9/9 Bot 在线、契约唯一值 1 个、bridge
> 全量 369/369、Delivery Outbox pending 0、`grants` 持续增长（真实流量）、
> orphan compute=1（设计内保守标记，Recovery 实见两次成功重放）。
> **真值备忘**：healthz `127.0.0.1:18765`；`systemctl --user`；控制面代码在 `app/` 子目录。

## ⓪ 已闭环（本轮 cc 处理）

- ~~dev198 生产 git 零入账~~ **已修**：`git reset --mixed origin/main`，
  untracked 38→14 / modified 71→4，工作树 md5 指纹逐行一致、`NRestarts=0` 零中断。
  剩余未跟踪全是应当如此的（`.ops-backups/` + 3 个 `.ops-hx-*` 一次性脚本 + 运行态）。
- ~~dev198 `control-plane/lib/version.mjs` v1.33.0 滞后~~ **已修**：sed 对齐 v1.33.1，
  md5 与 aliyun-hk 线上、origin/main 三方一致（防日后 rsync 把线上版本号降级）。
- dev198 磁盘上缺的两份交接文档已补回（handoffs / retrospectives）。

## A · 观察中（无需操作，触发即处理）

| # | 事项 | 触发条件 | 动作 |
|---|---|---|---|
| A1 | Base 展示层与本地账本漂移 | Base 上停在「执行中」但本地 durable 是 failed/interrupted | `base-intake-worker` 的展示层回填是 best-effort（吞错正确），但缺对账探针；周期比对本地终态 vs Base 状态，不一致告警 |
| A2 | full 模式脏会话 resume 卡死再现 | 任务莫名卡 ~2 分钟转后台 | 上 resume 首轮活性看门狗（N 秒无引擎日志弃 resume 换新会话） |
| A3 | grok 引擎抢协议复发 | 引擎又教用户自造停止口令 | 方法论三投放面禁令已下；复发则 prompt 更硬措辞或输出过滤 |
| A4 | kimi 挂 lark-cli 设备码授权到超时 | 「查通讯录」类任务跑满时限 | F5.2 后授权链接会落底送达；再挂死考虑 lark-cli 预授权或缩短设备码等待 |
| A5 | Kimi 订阅 403 额度墙 | 川哥拍板本轮跳过 | 恢复后必须由**该用户自己的** Kimi Runner + Bot 主动送达补验，禁止借用他人订阅 |

## B · 待川哥验收（功能已上线）

> **川哥 07-30 12:0x 拍板：五项需求验收暂缓**（他还有要排查调整的）。以下待他发话后再推。

| # | 事项 | 当前状态 |
|---|---|---|
| B1 | H-0027 Pi 本阶段能力 | 已修复待验收（durable 栈 + 公平调度 + orphan 恢复面均有线上活证据） |
| B2 | H-0031 Owner 自进化按钮卡 | 已修复待验收。**边界**：自动验收只允许打开详情，接受/应用/忽略必须人点 |
| B3 | H-0011 Base Intake Worker | 已修复待验收（healthz `baseIntake.claims.completed=2` = 真跑过两轮） |
| B4 | H-0037 分层记忆 | 已修复待验收（生命周期→ai-memory tier / 认知类型→用户私有 sidecar） |
| B5 | H-0051 dev198 性能 Tab | 已修复待验收（`/admin/runtime`、`/internal/runtime-metrics` 公网实测 401=存在且受保护） |
| B6 | F5.x 遗留：F5 完整剧本收尾 | 「停 #句柄」打字版 + 重启中断卡（叫我重启制造一次） |
| — | 微瑕（下批顺手）：kimi 续跑日志 `session=` 只显示 id 前缀 `session_`（sid 自带前缀，`slice(0,8)` 无区分度），改 `slice(8,16)` |

## C · 建议下一批（要拍板排期）

| # | 事项 | 一句话 | 预估 |
|---|---|---|---|
| C1 | **工具级审批**（penguin §5，队列下一项） | 四档模式 + pending 注册表 + 审批卡片（危险命令飞书卡确认，kill=deny），从「整任务放行+bwrap 兜底」升级到工具粒度 | 大 |
| C2 | Base ↔ 本地账本对账探针 | 见 A1，消除展示层静默漂移 | 小 |
| C3 | 新用户接入即时触发身份解析 | 消除部门「待认领」的 37 秒窗口 | 小 |
| C4 | kimi usage 采集落地 | F1 轨迹里 kimi usage=null；候选文件 `logs/kimi-code.log`，可实测抓取 | 中 |
| C5 | resume 首轮活性看门狗 | 不等 A2 再现，主动做掉 | 中 |
| C6 | F6b 增补任意性探针 | benchmark 目前只有 probe-receipt 一个真判别项 | 小 |

## D · 远期队列

跨主机事务层（多 Bridge/多 worker 水平扩展的一致 lease 与去重，PostgreSQL 或等价）→
AI 语义 compaction + 管理台 fork/merge → Native Kimi 影子看板与灰度闸门 →
跨引擎 handoff 注入演进 → F6c 评估中心 → F7 一句话建 bot → Phase O → Phase M。

（顺序据 `docs/pi-inspired-roadmap.md` §推荐顺序 + penguin 调研 §266）

## 已明确搁置

- 飞书扫码自动申请全部权限（川哥 2026-07-27 拍板搁置；重启需他提供具体报错抠 scope 串）
- aliyun-hk `/srv/h-control/` 下几十个 `app.bak-*` 历史备份目录待清（磁盘卫生，非紧急；
  清前必须确认哪个是现役——`systemctl cat h-control` 认 `WorkingDirectory`）
