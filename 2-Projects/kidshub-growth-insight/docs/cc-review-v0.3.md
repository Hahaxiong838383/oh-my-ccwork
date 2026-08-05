# cc 架构评审记录 · KidsHub Growth Insight v0.3

> 评审对象：[`architecture-v0.3.md`](./architecture-v0.3.md)
> 评审人：cc（Claude）｜日期：2026-08-05
> 状态：已含 2026-08-05 落地变更（域名路径拍板 + aliyun-hk 内存回收）

---

## 0. 结论

**建议推进，但 Phase 1 范围必须砍掉约一半。**

方案的分层、权限模型、迁移意识方向都对，问题不在架构，而在**范围与落地环境不匹配**：按原 Phase 1 写的范围（27 张表 + 13 个后台入口 + 双语言 + 容器化选项），2 周做不完；砍到本文 §5 的切片，10 个工作日可交付。

---

## 1. 实测校准

以下为 2026-08-05 真机实测，**推翻了方案中的若干假设**。

### 1.1 Studio（部署目标机）

`ssh studio` → `fu-121@fu-121deMac-Studio.local`，macOS 26.4.1，32GB。

| 方案假设 | 实测真值 | 影响 |
|---|---|---|
| 跑 Node/pnpm/PostgreSQL | **node / npm / pnpm / psql / docker / brew 全部 NOT FOUND**；python 仅系统自带 3.9.6 | 环境从零搭；无 brew，装 PG 需另选路径 |
| 空间 ~102GiB 够用 | avail **107GiB** 属实，但 `~/.ollama` 已占 **77GB** | 数字对，但增长曲线要定留存策略 |
| 干净的部署目标 | 在跑 Ollama(11434/11436)、LiveKit(7880/7881)、kidsbench(8081)、vision-daemon、voice-worker；**`com.lnmem.studio-nightly-train` 于 00:00 / 08:00 触发 QLoRA 训练**；`*:5000`/`*:7000` 被 macOS ControlCenter 占用 | 生产库与训练任务抢内存 |
| 端口 3100 / 3200 | 实测空闲 ✅ | 可用 |
| 避开 8081/11434/11435/11436/8000 | 判断正确。8000 当前空闲但 `com.mlx.server.9b` 配了 `KeepAlive=true`，随时会占 | 别用 8000 |

> 记忆中 Studio 定位为「纯执行节点，不装 git/npm」。本项目要在其上跑全栈 Web + 生产数据库，等于**改变该机定位**，需要明确知晓。

### 1.2 域名（原为阻塞项，已解决）

- `insight.kidshub.cn` 原先解析到 `8.217.184.210`，但那是 **`*.kidshub.cn` 泛解析兜底**（随机子域返回同一 IP）
- 该机为 Ubuntu + nginx/1.18.0，证书 `CN=kidshub.cn`，SAN 仅含 `kidshub.cn` / `www.kidshub.cn`，**不覆盖 insight**
- 该 IP **不在已登记的 11 台云机清单内**，控制权归属需确认（`kidshub.cn` 主站大概率由公司运维管）
- 结果：直接访问 `https://insight.kidshub.cn` 会命中另一台生产机 → 证书不匹配 + 404。**不是「还没配」，是「配错了但看起来像没配」**

**✅ 2026-08-05 川哥拍板：走 `8.218.26.17`（aliyun-hk）反代。** 落地路径见 §2.1。

### 1.3 aliyun-hk（反代机，原内存吃紧，已解决）

原状态 available 仅 306M 且**无 swap**。2026-08-05 已完成回收：

```
清理前  total 1612M · used 1306M · available 306M
清理后  total 1612M · used  736M · available 876M   (+570M)
运行中服务 32 → 21 个
```

已停用并清理：IPTV 全栈（容器 + 镜像 + `iptv-hls-proxy.service` + `iptv-validate-publish.timer/.service` + nginx include + snippets + `/opt/stacks/iptv-api` + `/var/lib/iptv-aiops`）、`docker.service`/`docker.socket`/`containerd`、`multipathd`/`tuned`/`fwupd`/`ModemManager`/`udisks2`。

备份：`/root/iptv-decommission-20260805/`（600 权限，含原 secrets 目录）。

**该机内存不再是本项目的阻塞项。**

---

## 2. 必须修改（上线前阻塞）

### 2.1 域名反代落地路径（决策已定，此处为执行口径）

```
浏览器 → https://insight.kidshub.cn (8.218.26.17)
  → nginx 新增 server block + LE 证书
  → proxy_pass 127.0.0.1:<frp 本地端口>
  → frps :7000（已在跑，frps.toml 无需改）
  → [公网] frpc（Studio 新装 + launchd 保活）
  → 127.0.0.1:3200  Next.js on Studio
```

五步，内存增量 < 5M（nginx server block 为 KB 级，frps 新增 proxy 约 1–2M；真正吃内存的 Next.js + PostgreSQL 都在 Studio 的 32GB 上）：

1. **alidns 加 A 记录** `insight.kidshub.cn` → `8.218.26.17` —— 必须加显式记录**覆盖泛解析**
2. **certbot 签证** insight.kidshub.cn（DNS 指过来后 HTTP-01 可行）
3. **nginx** 加 `sites-available/insight` + symlink（现有 10 站 / 20 server block / 14 个 443，加一个不影响）
4. **Studio 装 frpc** + launchd 保活
5. frps 已占端口 `7000/7881/17443/18080/18091/18443/18890/19080/19443/22022/22119/22198`，新隧道挑空闲端口（如 13200）

> ⚠️ **两条硬要求**
> - frpc 的 remotePort **不可直接公网可达**（用 stcp，或让 frps 只绑 `127.0.0.1`），否则可绕过 nginx 直击后端
> - nginx 层加 IP 白名单或 basic auth 作为应用登录之外的第二道门
>
> ⚠️ **改 nginx 的操作纪律**：`/etc/nginx/sites-enabled/` 是通配 include 目录，**备份文件绝不能放在里面**（2026-08-05 实测踩过：备份被当配置加载，报 `duplicate upstream`，`nginx -t` 直接变红）。备份放 `/root/`。

### 2.2 第一版删掉 Python Worker

MVP 阶段 JustOneAPI Token 尚未申请，worker **无活可干**；但引入它要付出第二套依赖管理（Studio 只有 python3.9.6，需先装 uv/pyenv）+ 第二套 launchd + 跨语言任务契约。CSV/Excel 解析在 TypeScript 侧（SheetJS/papaparse + exceljs）完全够用。

**改法**：架构上保留「任务表 + 独立进程消费」的解耦（`import_jobs` / `api_runs` 带状态机），实现上第一版就是一个 TS 长驻 worker 轮询同表。Phase 2 真需要 JustOneAPI Python SDK 时换消费者进程即可，DB 契约不变。

### 2.3 日快照表缺唯一约束 = 看板数字必然翻倍

`product_metrics_daily` / `creator_metrics_daily` / `content_metrics_daily` 无幂等键。重复采集或重复导入同一份 CSV → 数据翻倍且**不报错**，是会驱动错误投放决策的静默故障。

**改法**：每张日快照表加 `UNIQUE(entity_id, snapshot_date, source)`，写入走 `upsert`。全库时区口径明确为 `Asia/Shanghai`（存 UTC、聚合按东八区），否则电商日报跨日错位。

### 2.4 缺跨平台实体映射表，「竞品雷达」做不出来

同一达人在小红书/抖音是两个 ID，同一商品在天猫/京东是两个 SKU，同一品牌在不同数据源名字不同。27 张表中**无映射关系**，跨平台聚合无从做起。第一版不建，后补的成本是全表回填。

**改法**：MVP 即加
`entity_aliases(entity_type, canonical_id, source, source_id, raw_name, confidence, merged_by, merged_at)`；
且 `creators` / `products` / `contents` 全部补 `source` + `source_id` + `first_seen_at` + `last_seen_at`。

### 2.5 三个高风险写操作被当成普通开关

| 操作 | 现状 | 问题 | 改法 |
|---|---|---|---|
| editor 触发数据采集 | 是/否 | JustOneAPI 按量计费 = **给 editor 无上限烧钱权** | 日/月配额 + 单次上限，超限需 root 批 |
| 导出报表 | 后台开关 | 竞品数据 + 评论是核心资产，**无导出审计** | 加 `export_logs`（谁 / 何时 / 哪些行 / 文件哈希） |
| root 删除数据 | 是 | root 能删 `audit_logs` 则审计归零 | 审计表应用层 **append-only**，禁 UPDATE/DELETE |

另遗漏：**登录失败限流/锁定**（无注册 + 弱密码 = 直接爆破）、**session 吊销**（改密码后旧 session 是否失效未定义）、**软删除后谁能恢复/硬删**未定义。

### 2.6 Token 存储方案未定，且缺三个关键动作

`api_secrets` 称「存引用不存明文」，但引用指向何处未定（原文档 §17 问题 6 亦在问）。

**建议**：MVP 用 `~/kidshub-growth/secrets/secrets.env`（`chmod 600`，非 git），应用启动读入内存；DB 只存 `secret_ref`（键名）+ 后 4 位 + 更新时间 + 状态。
**不要用 Keychain** —— launchd 无 GUI session 时访问需 unlock，是经典踩坑点。Vault 对单机属过度设计。

缺失的三个动作：

1. **写入即活性校验**：存 Token 时立刻打一个轻量真实 API 验证，否则存了错的要等采集失败才发现
2. **日志脱敏用白名单不用黑名单**：第三方 API 报错时整个 response 对象丢日志 = 泄 Token
3. **不回显要在 Prisma `select` 层实现**，不能靠序列化时 `delete` —— 一个 `findMany()` 返回整条 record 就漏了

### 2.7 Prisma 生产迁移命令必须钉死

`prisma migrate dev` 检测到 drift 时**会重置数据库**。生产脚本只允许 `prisma migrate deploy`，且 `ops:restore` 必须校验 `_prisma_migrations` 版本与代码一致。不写进脚本，早晚有人在 Studio 上跑 `migrate dev` 清库。

---

## 3. 建议优化（不阻塞 MVP）

| # | 项 | 说明 |
|---|---|---|
| 1 | **飞书日报改法** | 原方案整块推到 Phase 4，届时要同时做「报告生成 + 推送」两件事。改为：MVP 即建 `reports` 表 + `generateReport()` 落 `data/reports/`，飞书只是一个 channel adapter，Phase 4 只剩推送代码（已有成熟飞书基建） |
| 2 | **LLM provider 统一成 OpenAI 兼容形状** | Claude / Grok / Ollama / MLX 均有 OpenAI 兼容端点，第一版只写一个 adapter。预留阶段不做多形状抽象 —— 形状越陌生越容易接错 |
| 3 | `analysis_results` 加 `input_hash` | 同输入不重复烧 LLM 钱，结果可复现 |
| 4 | `analysis_runs` 补 `model_id` + `prompt_version` | 否则换模型后无法归因效果变化 |
| 5 | 导入加 `import_job_rows` | CSV 1000 行错 3 行需能指出哪 3 行、错在哪；只有 `import_jobs` 做不到 |
| 6 | 指标加 `is_estimated` 标记 | 第三方 API 的销量/粉丝数很多是估算值，当真值进决策会误导。占位/估算值必须带来源标记 |
| 7 | campaign 补关联表 | 现仅有 `campaigns` + `campaign_reviews`，缺 `campaign_creators` / `campaign_contents` 多对多，复盘闭环断在此处 |
| 8 | 看板聚合走 `$queryRaw` | Prisma 聚合 API 对多表日报口径笨拙，直接写 SQL 更快也更好读 |
| 9 | **MLX 不写进 Phase 4 承诺** | 实测 Studio `:8000` 未监听，`com.mlx.server.9b` 上次退出码为 1。列入 provider 清单可以（是预留），但不能当作可用算力排期 |
| 10 | 导出权限只做角色级 | 「按用户配」是在 RBAC 之外引入第四维 ACL，两套会打架。MVP 角色级足够 |

---

## 4. 风险清单

| 类别 | 风险 | 等级 | 缓解 |
|---|---|---|---|
| **合规** | JustOneAPI/TikHub 的数据来源本身是爬取。用第三方 API **不会自动转移责任** —— 数据落进自己的库，责任跟着数据走 | 🔴 高 | 明确写死「仅内部决策参考，不对外输出、不进产品、不给客户看」。一旦对外，风险量级不同 |
| **合规** | 评论数据含用户昵称/头像/UGC = **个人信息**（PIPL 适用） | 🔴 高 | 评论表只存**内容与统计特征**，不存昵称/头像/用户 ID，或存哈希；定保存期限 |
| **成本** | 竞品每日全量监控，SKU 数 × 天数增长快；editor 可无限触发采集 | 🟠 中高 | 设计阶段先定「监控多少 SKU × 多久一次」；配额见 §2.5 |
| **数据** | 重复采集/导入无幂等键 → 数字静默翻倍 | 🔴 高 | §2.3 唯一约束 |
| **数据** | raw snapshot 无留存上限；Studio 剩 107GiB 且 Ollama 已占 77GB | 🟠 中 | 定留存策略（raw 保 90 天后转冷备到 NAS `192.168.61.18`） |
| **部署** | **00:00 / 08:00 QLoRA 夜训抢内存**，Postgres 在内存压力下会被换页 | 🟠 中高 | PG `shared_buffers` 保守设 1–2GB；采集任务错开 23:00–10:00 |
| **部署** | Studio 单点，无 UPS、无故障转移；备份若只在本机 = 没有备份 | 🟠 中 | 备份必须落到另一台机（NAS `192.168.61.18`），launchd 定时 |
| **部署** | ~~aliyun-hk 内存吃紧（353M）~~ | ✅ 已解除 | 2026-08-05 回收至 876M（§1.3） |
| **部署** | aliyun-hk 的 docker 栈已停用 | 🟡 低 | 若日后要在该机跑容器需重新 `systemctl enable --now docker` —— 这进一步支持「Studio 侧不容器化」的结论 |
| **迁移** | 备份不演练 = 薛定谔的备份 | 🟠 中 | Phase 1 验收**必须含一次真实异机恢复**，不是脚本能跑就算过 |
| **迁移** | 迁移包含全部竞品数据+评论，落 NAS/云 = 明文资产 | 🟠 中 | `ops:export --encrypt`（age/openssl），密钥单独走 |
| **迁移** | `pg_dump` 跨大版本恢复可能失败 | 🟡 低 | manifest 记 PG 大版本，restore 前校验 |
| **安全** | 无登录限流；上公网后直接暴露 | 🟠 中高 | §2.5 + §2.1 的双门要求 |
| **依赖** | insight 挂上 aliyun-hk 后，该机 **2026-08-22 实例到期**从「该续」变成「不续就断」 | 🟠 中高 | 川哥手动续（已确认） |
| **依赖** | 同机 `my.chenchuan.cc` 证书 **2026-08-17 到期且续期已失败**（DNS 指向韩国机，HTTP-01 到不了香港） | 🟠 中 | 已出独立处理 prompt，另开 session 走 DNS-01 |
| **安全** | Studio 跑着 CorpLink（公司 VPN），同时是公司算力节点 | 🟡 低 | 确认该机资产归属与 IT 管控边界，避免日后数据归属扯皮 |

---

## 5. MVP 切片

> **关键认知**：Prisma 加表很便宜，「预留」不需要现在建 11 张空表。真正需要现在定死的是 **ID 体系、溯源字段和唯一约束** —— 那些后补要全表回填。

### 表（16 张，从 27 砍下来）

```
认证审计  users / sessions / audit_logs / login_attempts
系统      app_settings
主数据    categories / brands / watch_keywords / creators / products
映射      entity_aliases          ← 必须第一版（§2.4）
数据源    data_sources / api_secrets
导入      import_jobs / import_job_rows / raw_snapshots
```

- Phase 2 加：`*_metrics_daily` / `*_comments` / `contents` / `api_runs`
- Phase 3 加：`campaigns` / `campaign_creators` / `campaign_contents` / `campaign_reviews`
- Phase 4 加：`analysis_*` / `manual_tags` / `creator_scores`
- 建议提到 MVP：`reports`（§3.1）、`export_logs`（§2.5）

### 页面（6 个，从 13 个入口砍下来）

| 路由 | 内容 |
|---|---|
| `/login` | 邮箱密码 + 失败限流 |
| `/` | 首页：计数卡 + 最近导入 + 健康状态（无数据时不做复杂看板） |
| `/admin/master-data` | **一页 5 个 tab**：品类/品牌/关键词/达人/商品（不做 5 个页面） |
| `/admin/data-sources` | 数据源 + Token 配置（不回显 + 写入即校验） |
| `/admin/import` | 上传 + 任务列表 + 行级错误 |
| `/admin/users` | 账号管理 + session 吊销 |

LLM Provider / Prompt 模板两个「占位页」MVP 不做 —— DB 留表即可，空页面是负债不是资产。

### 接口（~15 个 Route Handler）

`POST /api/auth/login|logout` · `GET /api/me` · `CRUD /api/master/{categories,brands,keywords,creators,products}` · `CRUD /api/data-sources` · `PUT /api/data-sources/:id/secret` · `POST /api/import/upload` · `GET /api/import/jobs/:id` · `GET /api/dashboard/summary` · `GET /api/healthz`

### 脚本

```
ops:setup            # 建目录 + 装 PG + 初始化
ops:seed-root        # 初始化 root（密码从 stdin，不入 history）
ops:export           # 迁移包（支持 --encrypt / --since）
ops:restore          # 恢复（--dry-run + PG 版本校验 + migration 版本校验）
ops:healthcheck      # 前端/后端/DB/磁盘/raw 校验和
ops:backup           # 定时备份到 NAS 192.168.61.18
ops:rotate-secrets   # Token 轮换
```

---

## 6. 实施顺序（10 个工作日）

| Day | 任务 | 完成判据 |
|---|---|---|
| 1 | Studio 环境：Node 24 + pnpm + **Postgres.app**（无 brew 路径）+ 目录 + launchd 保活 | `psql -c 'select 1'` 通、开机自启验证过 |
| 2 | Prisma schema（16 张表 + 唯一约束 + 时区）+ migrate + seed root | `migrate deploy` 跑通，root 能登录 |
| 3 | 认证 + RBAC 中间件 + audit 中间件 + 登录限流 + 账号管理页 | 三角色越权测试全部 403 |
| 4–5 | 主数据 CRUD（含 `entity_aliases`） | 五类实体可增删改查，别名可合并 |
| 6 | 数据源 + Token（不回显 + 活性校验 + 日志脱敏） | 存错 Token 立刻报错；日志 grep 不到明文 |
| 7–8 | 导入：上传 → 解析 → 行级错误 → raw 归档 | 故意投一个 3 行错的 CSV，能定位到行 |
| 9 | 首页看板 + `reports` 表 + `generateReport()` | 报告能落盘 |
| 10 | 迁移脚本 + **异机真实恢复演练** | 在 Air 或 NAS 上恢复一次并登录成功 |

**Day 10 的异机恢复是硬验收**，不能用「脚本跑通了」代替。

域名反代（§2.1 五步）可与 Day 1–2 并行，或在 Day 9 之后接入 —— 不阻塞主线开发（本地 `http://192.168.61.177:3200` 即可开发验收）。

**Day 1 之前需拍板**：JustOneAPI 是否现在申请（不影响 MVP，但影响 Phase 2 排期）。

---

## 7. 最终推荐技术栈

大方向同意原方案，**三处改动**：

| 层 | 原方案 | 推荐 | 理由 |
|---|---|---|---|
| 应用 | Next.js 前端 + 独立 Node API（3100+3200） | **Next.js 15 App Router 全栈单进程**（Route Handlers 做 API，仅 3200 一个端口） | 内部系统、单机、单人开发、无外部 API 消费者 → 独立 API 进程纯粹多一个部署单元 + 类型同步 + CORS。逻辑写在 service 层，日后要拆很便宜 |
| Worker | Python Worker | **第一版无 Python**，TS 单 worker 轮询 DB 任务表 | §2.2 |
| 队列 | 后续加队列 | **不上 Redis/BullMQ**，DB 表当队列 | 单机低频，队列是纯负担 |
| 认证 | 邮箱密码 + RBAC | **手写 session cookie**（httpOnly + SameSite=Lax）+ argon2 | 3 个内部账号上 NextAuth 属过度设计且升级坑多。手写约 150 行 |
| 进程管理 | launchd/cron/PM2 | **launchd** | Studio 现有服务全是 launchd 管的，一致性优先；且 PM2 有 env 快照压制 env-file 的坑 |
| 数据库 | PostgreSQL + Prisma | **同意**，PostgreSQL 17（Postgres.app 安装） | Studio 无 brew 无 docker，Postgres.app 是最省事路径。Prisma 的 migration 文件正是「一键迁移」需要的版本锚 |
| 容器化 | 待定 | **第一版不容器化**，但写一份 `docker-compose.yml` 作为迁移目标格式 | Studio 无 docker；Docker Desktop 在 macOS 是 VM，叠在 Ollama(77GB 模型) + LiveKit + 夜训之上是纯损耗；且 Docker Desktop 对企业使用需付费订阅 —— KidsHub 是公司业务，这是真实合规点 |

**不同意改 FastAPI**：核心工作量是后台 CRUD + 权限 + 导入 + 看板，不是数据科学。FastAPI 在这些上没有优势，反而要手写更多后台脚手架，还要维护前后端类型同步。

---

## 8. 已落地变更与待办

### 已落地（2026-08-05）

- ✅ 域名路径拍板：走 aliyun-hk（8.218.26.17）反代，执行口径见 §2.1
- ✅ aliyun-hk 内存回收：available 306M → 876M（IPTV 全栈 + docker 栈 + 5 个低价值系统服务）
- ✅ 该机 10 站公网 E2E 全部验收通过；备份留在 `/root/iptv-decommission-20260805/`

### 待办

| 项 | 负责 | 时限 |
|---|---|---|
| aliyun-hk 实例续费 | 川哥手动 | **2026-08-22** |
| `my.chenchuan.cc` 证书改 DNS-01 | 独立 session（prompt 已出） | **2026-08-17** |
| `8.217.184.210` / `kidshub.cn` 主站 DNS 控制权归属确认 | 川哥 | 加 A 记录前 |
| JustOneAPI 是否现在申请 | 川哥 | Phase 2 前 |

---

*署名：cc（Claude）| 2026-08-05*
