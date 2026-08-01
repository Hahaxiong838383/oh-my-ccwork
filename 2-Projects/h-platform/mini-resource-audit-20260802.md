# Mini 资源盘点（2026-08-02 07:36 实测）

为 B2 路线 A（执行面搬进 Lima VM）做容量决策。**只读盘点，未停任何服务。**

## 结论先说：不需要 kill 任何东西

| 指标 | 实测 |
|---|---|
| 物理内存 | **32 GB** |
| 可用（free+inactive+speculative） | **19.2 GB** |
| swap 使用 | **0.00 MB**（从未换页） |
| free 占比 | 91% |
| 负载 | 1.38 / 1.57 / 1.62（10 核，4 性能核） |
| 磁盘 | 219G 已用 / 220G 可用（50%） |

VM 按 8GB 上限规划，仍余 11GB。**「内存吃紧」的前提不成立**——
Mini 是 32G M4，不是想象中的小机器。

⚠️ 而且盘点当时 **Lima VM 已经在跑**（昨晚建的 h-b2，`Virtualization.VirtualMachine`
占 2071MB）——也就是说上表的 19.2GB 可用**是已经扣掉一台 VM 之后的余量**。

## H 平台自身占用（该保的，共约 209MB）

| 服务 | RSS |
|---|---|
| `com.hplatform.mini-bot.bridge` | 130 MB |
| `com.hplatform.mini-bot.runner` | 51 MB |
| `com.hplatform.memory.u-aca292be3f`（ai-memory 实例） | 28 MB |

整个 H 平台执行面只占 0.2GB。**它不是内存压力来源**。

## 占用排行（≥100MB 的自建/应用）

| RSS | 归属 | 性质 |
|---|---|---|
| 2174 MB | Brave 浏览器（13 进程） | 川哥在用 |
| **2071 MB** | **Lima VM（h-b2）** | 昨晚建的 B2 POC，**在跑** |
| 907 MB | EXO（2 进程） | 别的项目 |
| **479 MB** | **`com.hplatform.mini-ab`（6 服务）** | **codex 的 A/B POC，见下** |
| 246 MB | UURemote agent | 远程控制 |
| 245 MB | `dev.mycc.backend` | mycc 后端 |
| 184 MB | UURemote 主体 | 远程控制 |
| 142 MB | limactl（VM 管理进程） | 随 h-b2 |
| 121 MB | Xray 代理 | **不能停**（grok 出网 + GitHub 出站铁律） |
| 58 MB | ollama（本机） | **不能停**（Mini embedding 刚切到它） |
| 58 MB | `cc.remote.v4`（7 进程） | 远程终端 |
| 38 MB | frpc / multica daemon | 隧道 / multica |

## 唯一值得回收的候选：`com.hplatform.mini-ab`（479 MB）

这是 codex 的 A/B POC 六服务（Router/Policy/Gateway/Audit/FakeTools/Metrics，
端口 18110-18115），路径 `~/local/h-platform-mini-ab`。

**判它闲置的依据**（交接文档 `docs/handoffs/2026-07-31-mini-ab-poc.md` 原文）：
- `H_AB_CANARY_PERCENT=0` —— 不承载任何真实流量
- 「当前阶段使用 **fake tools**，不连接生产飞书长连接，不读取生产 `.env`」
- B0/B1/B3 三项验收**均已通过**，POC 使命完成
- 与生产执行面 `~/local/h-platform-mini-bot` 是**两套独立目录/端口/LaunchAgent**，
  停它不影响 AI 专家 Bot

**但它不是必须停**——19.2GB 余量下省这 479MB 没有实际收益。
真要停：`launchctl bootout gui/$(id -u)/com.hplatform.mini-ab`，
回滚 `launchctl bootstrap`。**归档前建议先确认 codex 是否还要用它的审计 SQLite 数据。**

## 不建议动的

- **Xray（121MB）**：Mini 的 GitHub 出站与 grok 出网都依赖它，停 = fail closed
- **ollama（58MB）**：Mini 的记忆 embedding 2026-08-02 刚切到本机 11434
- **Brave / EXO / UURemote / mycc backend**：川哥自己的东西，不该由我建议

## 端口占用实况（避免 VM 端口撞车）

已占：`2019 caddy` / `8888` / `10052-10053` / `10808 xray` / `11434 ollama` /
`11436 ssh隧道` / `15721` / `18080` / `18090` / `18110-18115 mini-ab` /
`18775 mini-bot healthz` / `19001-19003 ttyd` / `19080` / `19443` / `19514` /
`37777` / `49500 ai-memory` / `49957+52415 exo` / `54673-54674 limactl`

VM 内服务若要暴露到 host，避开以上端口。
