# GEO 公网受控操作台部署验收

日期：2026-08-14（Asia/Shanghai）

## 结论

`https://geo.kidshub.cn/` 已上线 GEO Engine `0.4.2` 动态 API Control Room 与公开内容层。当前生产 Release 锚定 Commit `ec249ed0c7d7a45b8b8b8ea7e3b9fabf42036bf1`；Dashboard/API 采用独立认证、认证全量 fallback、已知高风险 exact 规则、动态命名空间护栏和受限反向 SSH，公开内容仅通过 `/published/<file>` 与根发现文件读取，公司虚拟机 `8080` 和阿里云回环端口均未直接暴露公网。

GEO 主进程由系统级 systemd 托管，使用固定 Git Release 和独立 venv，监听固定为 `127.0.0.1:8080`，模型 Key 与发布目录配置仅由 `0600` EnvironmentFile 注入。前端从正式域名动态读取 API；认证后整个上游 API 路径空间可通过 fallback 访问，已知高风险写接口仍由 exact location 实施更严格的方法、请求体、限流和超时。SQLite 当前为 4 个知识库、906 个切片、7 篇文章、12 条可见性记录、5 条实验且 `integrity_check=ok`；其中 5 篇文章已有 `geo.kidshub.cn/published/` 公开 URL 并逐条返回 `200`。

## 生产拓扑

```text
浏览器
  -> geo.kidshub.cn:443
  -> aliyun-hk Nginx + 独立 Basic Auth
  -> aliyun-hk 127.0.0.1:13808
  -> geo-tunnel 受限反向 SSH
  -> company-vm 127.0.0.1:8080
  -> GEO Engine /dashboard
```

安全边界：

- DNS `geo.kidshub.cn` A 记录指向 `8.218.26.17`。
- 阿里云只在 `127.0.0.1:13808` 接收隧道，公网探针不可达该端口。
- 隧道使用独立 `geo-tunnel` 账号和独立 ED25519 密钥；`authorized_keys` 只允许端口转发和 `permitlisten="127.0.0.1:13808"`。
- 公司虚拟机使用 `geo-dashboard-tunnel.service` 托管隧道，启动前先验证 GEO `/health`，异常退出自动恢复。
- GEO 主服务由 `/etc/systemd/system/geo-engine.service` 托管；隧道 unit 使用 `Requires/After=geo-engine.service`，并在 `ExecStartPre` 内等待健康端点，避免系统启动或同时重启时抢跑。
- Nginx 公开只读 `/health`；其余路径与方法先经过 Basic Auth，再由 `location /` fallback 代理到回环上游。已知 POST 写接口保留 exact location，因此错误方法仍优先返回 `405`，并继续使用独立请求体、限流和超时。`/(articles|kb)/<numeric-id>` 使用锚定数字规则；其余 `/articles/`、`/kb/` 子路径由命名空间 guard 返回 `404`，防止后端宽松前缀解析。
- `/published/<file>` 无需 Dashboard 凭据，但只允许 GET/HEAD 和发布目录根层的 HTML、Markdown、XML、TXT、JSON/JSON-LD 文件；禁止写方法、目录遍历和未知扩展。`/robots.txt`、`/llms.txt`、`/schema.jsonld`、`/sitemap.xml` 映射到同一受控目录。
- 公开首页由机器结构生成器静态生成，不执行客户端脚本；文章 HTML 对正文和属性做转义，canonical、Open Graph、JSON-LD 与数据库交付 URL 统一指向 `https://geo.kidshub.cn/published/`。
- fallback 使用 `geo_dashboard burst=30`、`client_max_body_size 5m`、读超时 `900s`、写超时 `120s`。这意味着后端新增顶层接口会自动对已认证用户可达，后端参数校验、权限和审计必须承担最终安全边界。
- `/articles/update`、`/publish`、`/gen`、`/kb/create`、`/kb/add`、`/visibility/multi` 虽保留 exact 方法/请求体/超时规则，但限流已切换为与 fallback 相同的 `geo_dashboard rate=120r/m burst=30`，避免六个工作流接口共享低速桶互相触发 `503`。
- `/visibility`、`/audit`、`/fix` 继续使用慢操作 `geo_operations rate=6r/m burst=2`；它们本身耗时长或风险高，快速重复提交仍可能被 `503` 限流。
- `/articles/update` 限制 `2m/60s`，`/publish` 为 `120s`，`/gen` 为 `16k/600s`，`/kb/create` 为 `16k/60s`，`/kb/add` 为 `5m/120s`，`/fix` 为 `16k/90s`，`/visibility/multi` 为 `16k/900s`。
- 生产 `/publish` 由 `GEO_PUBLISH_DIR` 和 `GEO_SITE_URL` 固定目录与公开根 URL，EnvironmentFile 优先于请求体；`/fix` 仍允许调用方指定输出目录。Basic Auth 凭据属于高权限运维凭据，不得分享给普通访客、写入前端、Git、日志或协作消息。
- `/audit` 只允许公网 HTTP(S) 目标，拒绝内网、本机、保留地址和私有重定向；响应体限制 5MB。`/visibility` 与 `/audit` 分别单并发，Nginx 另加操作限流。
- 公网页面要求独立认证，凭据仅保存在批准的离线位置和远端 Hash 文件，不进入 Git、Skill、记忆或日志。

## 部署资产

### aliyun-hk

- Nginx 站点：`/etc/nginx/sites-available/geo-kidshub`
- 启用链接：`/etc/nginx/sites-enabled/geo-kidshub`
- 认证 Hash：`/etc/nginx/.htpasswd-geo`，权限 `0640 root:www-data`
- 隧道账号：`geo-tunnel`
- 隧道回环端口：`127.0.0.1:13808`
- TLS：Let's Encrypt ECDSA，证书到期日 `2026-11-12`
- Nginx 发布前快照：`/root/nginx-before-geo-20260814-100133.conf`
- `0.4.x` API 白名单切换备份：`/root/geo-kidshub-before-v040-20260814-122001.conf`
- 七个 POST 白名单切换备份：`/root/geo-kidshub-before-post-whitelist-20260814-142332.conf`
- 文章详情 GET 白名单切换备份：`/root/geo-kidshub-before-article-detail-20260814-152610.conf`
- 文章/知识库数字详情组合规则备份：`/root/geo-kidshub-before-kb-article-detail-20260814-154615.conf`
- 认证全量 fallback 前备份：`/root/geo-kidshub-before-auth-fallback-20260814-170035.conf`
- fallback 命名空间护栏前备份：`/root/geo-kidshub-before-fallback-guards-20260814-170354.conf`
- 六接口限流修复前备份：`/root/geo-kidshub-before-post-rate-fix-20260814-171326.conf`
- 公开发布路由前备份：`/root/geo-kidshub-before-public-release-20260814-180832.conf`
- 根发现文件路由前备份：`/root/geo-kidshub-before-discovery-files-20260814-181625.conf`
- 命名捕获修复前备份：`/root/geo-kidshub-before-named-discovery-20260814-182033.conf`
- 当前 Nginx 配置 SHA-256：`c60604c37aa4836f611936f4491119baa789d6a02d93a1e22ce71f4b9641268e`

### company-vm

- 上游 Commit：`ec249ed0c7d7a45b8b8b8ea7e3b9fabf42036bf1`
- 当前 Release：`/home/futurus/.geo-engine/releases/company-ai-ontology-ec249ed0c7d7a45b8b8b8ea7e3b9fabf42036bf1`
- 当前代码指针：`/home/futurus/.geo-engine/current`
- 独立 venv：`/home/futurus/.geo-engine/venvs/geo-engine-ec249ed0c7d7a45b8b8b8ea7e3b9fabf42036bf1`
- GEO 系统服务：`/etc/systemd/system/geo-engine.service`
- GEO EnvironmentFile：`/home/futurus/.config/geo-engine/geo-engine.env`，权限 `0600`
- GEO 数据：`/home/futurus/.geo-engine/geo_engine.db`
- 隧道服务：`/etc/systemd/system/geo-dashboard-tunnel.service`
- 隧道密钥目录：`/home/futurus/.geo-engine/tunnel/`
- 首次 systemd 切换备份：`/home/futurus/.geo-engine/backups/systemd-cutover-20260814-105641`
- `0.3.2` 模型/发布状态切换备份：`/home/futurus/.geo-engine/backups/model-publish-v032-20260814-113147`
- `0.4.0` API/实验账本切换备份：`/home/futurus/.geo-engine/backups/api-console-v040-20260814-121834`
- `0.4.1` 上海时区修复备份：`/home/futurus/.geo-engine/backups/timezone-v041-20260814-122512`
- `0.4.2` 首次公开发布备份：`/home/futurus/.geo-engine/backups/public-release-c0264587-20260814-180700`
- 最终公开内容与数据库备份：`/home/futurus/.geo-engine/backups/public-final-f884ef3-20260814-181527`
- 公开发布目录：`/home/futurus/.geo-engine/data/published`，当前 16 个文件，仅包含静态首页、5 篇账本文章及机器发现文件。
- GEO 运行读数：4 个知识库、906 个切片、7 篇文章、2 篇草稿、0 篇仅导出、5 篇公开发布、12 条可见性记录、5 条实验记录。
- 当前资料包版本：`kbp-6adb88da8625`，148,793 tokens。
- 生成配置：`GEO_GENERATION_MODEL=deepseek-v4-flash`、`GEO_REASONING_EFFORT=max`。

GitHub 组织策略禁止该仓库使用 Deploy Key，因此没有把个人 Token 或私钥复制到服务器。标准部署流程由本机已授权 GitHub 会话 `fetch` 主线，生成含完整历史的 Git Bundle，校验 SHA-256 后传入 company-vm 并创建可审计 Git Release。本轮遇到协作者连续推送与生产热补丁：先逐文件核对 Hash，Git push 被并发更新拒绝后重新 fetch/rebase，最终以 `ec249ed` 重建 clean Release；生产工作树当前为 clean，禁止回退到热补丁覆盖模式。

可重复运维资产位于 `deploy/company-vm/`：`geo-engine.service`、`geo-dashboard-tunnel.service`、`activate-geo-engine-release.sh` 和 `cutover-geo-engine-release.sh`。首次激活脚本负责备份和安装系统单元；后续切换脚本接收新旧 Commit、目标版本、模型和推理等级，原子更新 Release/venv 指针，轮询 `/health` 并校验 `/stats`，失败自动恢复旧 Release；脚本不读取或打印 Secret。

## 验收证据

| 验收项 | 结果 |
|---|---|
| DNS A 记录 | `8.218.26.17` |
| 未认证首页 | `401` |
| 认证后 Dashboard | `200`，HTML `36039` bytes |
| Dashboard 标题 | `GEO Control Room · 爱视可` |
| `/health` | `200` |
| 未认证 `/stats` | `401` |
| 认证 `/stats`、`/kb`、`/articles`、`/meta`、`/experiments` | 全部 `200` |
| GET `/audit`、`/visibility` | `405` |
| GET 七个 POST-only 新增写接口 | 全部 `405` |
| 六个工作流 POST 连续三轮、共 18 次空 JSON | 全部后端缺参 `400`，`503=0` |
| 公开 `/published/<file>` | 5 篇数据库交付文章逐条 `200`；POST `405`，认证路径穿越 `404` |
| 根发现文件 | `/robots.txt`、`/llms.txt`、`/schema.jsonld`、`/sitemap.xml` 全部 `200` |
| 公开内容安全 | 16 个文件，非 JSON-LD 可执行脚本 0，敏感模式命中 0，旧 `content.eyescare.cn` 基址残留 0 |
| `/visibility`、`/audit`、`/fix` | 继续使用慢操作限流区 |
| 认证 GET `/articles/5` | `200`，文章正文 4,259 字符 |
| 认证 POST `/articles/5` | `405` |
| 认证 GET `/articles/foo`、`/articles/5/delete` | Nginx guard `404`，未到后端 |
| 未认证 GET `/kb/1` | `401` |
| 认证 GET `/kb/1` | Nginx 已放行，后端 JSON `404 未知端点`；待实现知识库详情 |
| 认证 POST `/kb/1`、GET `/kb/create` | `405` |
| 认证 GET `/kb/foo`、`/kb/1/delete` | Nginx guard `404`，未到后端 |
| 未认证 fallback 路径 | `401` |
| 认证未知 GET/POST 路径 | 后端 JSON `404 未知端点` |
| 认证 `/keywords` | `200`，关键词数 0 |
| `/keywords/add`、`/keywords/delete` 空 JSON | 后端缺参 `400`，无数据副作用 |
| TLS SAN | `geo.kidshub.cn` |
| Certbot renew dry-run | 成功 |
| 外部访问 `13808` | filtered/timeout |
| 隧道重启恢复 | active，`NRestarts=0` |
| 连续公网请求 | 3/3 返回 `200` |
| 前端/后端数据一致性 | 4 个知识库、906 个切片、7 篇文章、12 条可见性记录、5 条实验记录完全一致 |
| 生成模型 | `deepseek-v4-flash`，最高推理 `max` |
| 发布状态 | 2 篇草稿、0 篇仅导出、5 篇公开发布；全部交付 URL 返回 `200` |
| 资料包版本 | `kbp-6adb88da8625`，4 个知识库、906 个切片、148,793 tokens |
| AI 可见性操作 | 爱视可/`eyescare.cn`：`0/100`、品牌提及 `0/6`、域名引用 `0/6`，实验 #2 |
| 网站审计操作 | `ai.kidshub.cn` 登录页 smoke：`19/100`、D、21 项问题，实验 #1 |
| Tab active | 总览、AI 可见性、网站审计、内容资产、知识库、关键词库、实验记录七项可达 |
| 关键词与生成 UI | 关键词库空状态、内容生成表单和关键词空状态正常，`/keywords` 响应 `200` |
| 桌面浏览器 | `1440px`，无横向溢出，动态 API、操作结果和上海时间正确 |
| 移动浏览器 | iPhone `393px`，无横向溢出，Tab 与操作表单完整 |
| 浏览器控制台 | `0` 错误、`0` 警告 |
| “查看 / 修正”弹层 | WebKit 加载文章 #7，正文 6,407 字符，详情响应 `200`，弹层错误 0 |
| systemd 依赖重启 | GEO 与隧道同时重启通过，双方 `NRestarts=0` |
| company-vm LAN `8080` | 不可达，仅回环监听 |
| Nginx GEO error log | 空 |

既有 Dashboard 的桌面与移动布局、七个 Tab、动态 API、关键词库、内容生成表单、操作页、实验账本、上海时间和控制台曾通过真实 Playwright WebKit。`0.4.2` 最终部署时本机缓存 WebKit 因高于当前 macOS 版本无法启动，因此本轮新增链路使用生产 HTTP、静态 DOM、5 个真实公开 URL、无脚本首页、API 和数据库对账验收；未把浏览器驱动失败误报为站点失败，也未安装新依赖。

## 如何判断文章是否发布、是否有效

Dashboard 的文章状态采用以下口径：

- `草稿`：文章仅生成，尚未通过人工审核。
- `已审核 · 待发布`：人工审核通过，但没有向外部平台交付，不等于已经发布。
- `已导出 · 未公开`：已生成静态 HTML/Markdown 文件，但没有公开 URL，公网和搜索引擎仍不可见。
- `已公开`：外部发布平台成功返回公开 URL，并记录发布时间、平台和链接；只有该状态才算真正发布。

效果判断必须在文章公开后继续运行 AI 可见性检测，观察发布前后同一批问题的可见性分数、品牌提及次数、品牌域名引用次数和竞品信号变化。单篇文章与品牌整体变化之间只能作为相关性线索，不能直接宣称因果；当前已有 5 个公开 URL，但最新 `0/100` 记录产生在本轮公开链路完成前，仍需等待抓取窗口后按同一问题集复测。

## 经验教训

1. **DNS 生效不等于 HTTPS 可用**：部署前 `geo.kidshub.cn` 已指向正确 IP，但因为没有独立 Nginx `server_name` 和证书，TLS 命中了 ERP 默认证书。
2. **不能做无认证裸反代**：GEO 原始服务同时包含读写接口。当前允许 Basic Auth 后的全量 fallback，但必须保留高风险 exact 门禁、动态 namespace guard，并明确 Basic Auth 用户获得整个 API 权限；公司虚拟机 `8080` 和阿里云回环端口仍不得直接暴露公网。
3. **反向端口必须绑定回环**：阿里云回环监听、受限 `permitlisten`、安全组无对应端口和公网探针四项要同时成立。
4. **隧道 active 不等于页面可用**：验收必须覆盖公司机 `/health`、阿里云回环 Dashboard、公网认证页面和隧道真实重启恢复。
5. **凭据应与业务系统隔离**：GEO 独立访问凭据不复用 H 管理员密码、Ontology 密码或模型 API Key，Hash 与明文分开保存。
6. **证书发布必须带续期证据**：首次签发成功后立即执行指定证书的无随机延迟 dry-run，避免把“当前可用”误报为“可持续运行”。
7. **systemd 的 `After` 不等于应用已健康**：同时重启 GEO 与隧道时，隧道单次 `curl` 可能早于后端监听；应在 `ExecStartPre` 内有限重试，并保留 `Restart=always`。
8. **私有仓机器同步不能复制个人 Token**：仓库禁用 Deploy Key 时，使用已授权机器生成完整历史 Git Bundle、固定 Commit 与 Bundle Hash，服务器只接收可审计 Release。
9. **editable install 会污染不可变 Release**：生产 venv 使用普通安装，Release 工作树必须保持 clean；运行版本同时核对 Git Commit、包版本和服务入口。
10. **审核、导出和公开发布必须分开**：本地文件生成成功不能写成 `published`；只有外部平台返回公开 URL 才记录为公开发布。
11. **模型名称不等于推理等级生效**：必须同时校验请求体中的 `model`、`reasoning_effort` 和返回 usage；生产环境再用 EnvironmentFile 覆盖，避免调用方误传低档参数。
12. **单篇内容不能直接归因品牌整体效果**：发布效果依赖后续同口径可见性检测；没有公开 URL 或没有发布后观测时，Dashboard 必须明确显示“不能判断”。
13. **长操作不能阻塞健康面**：`HTTPServer` 执行 6 次 AI 查询时会阻塞所有请求；操作页上线后改为 `ThreadingHTTPServer`，并用单并发信号量防止同类任务重复提交。
14. **网站审计必须防 SSRF**：仅靠 Basic Auth 不足以允许服务端抓任意 URL；必须拒绝非公网 IP、逐跳检查重定向并限制响应体。
15. **SQLite 时间默认是 UTC**：实验记录首次显示比上海时间少 8 小时；前端必须把无时区的 SQLite 时间按 UTC 解析，再显式转换到 `Asia/Shanghai`。
16. **拼出 URL 不等于真实发布**：只有发布目录实际由公网路由提供、canonical/OG/JSON-LD/数据库交付 URL 一致且逐条返回 `200`，才能写为 `published`。
17. **Nginx 捕获变量会被后续正则覆盖**：regex location 使用 `$1` 时，内部方法判断的正则也会改写 `$1`，导致根发现文件代理到错误路径；使用命名捕获变量并做真实 `/robots.txt`、`/llms.txt` 验收。
18. **机器可读首页不能把文本直接拼进 `innerHTML`**：文章标题和摘要属于可变内容，必须服务端转义并生成纯静态卡片；公开目录扫描需保证非 JSON-LD 可执行脚本为 0。
19. **并发发布必须重新获取真值**：准备、提交、推送和生产切换之间远端可能继续推进；push 被拒绝时禁止强推，必须 fetch/rebase，生产热补丁先以 Hash 证明已入 Git，再重建最终 clean Release。
20. **公开目录只保留账本内容**：未进入数据库交付记录、索引和 sitemap 的孤儿文件应 fail-closed 下线；先做目录归档，再移出公网，禁止无证据保留。

## 当前遗留门禁

- Basic Auth 是第一阶段独立认证；若进入多人使用，应接入 H 管理员认证或公司统一身份体系。
- GEO Dashboard 会在认证后的 HTML 内嵌当前文章、任务、知识库和可见性数据；不得改成公开无认证站点。
- 当前 5 篇文章已通过 `geo.kidshub.cn/published/` 公开，后续新增文章仍必须经过人审和发布授权；部署授权不能自动外推为未来内容授权。
- 等搜索引擎与 AI 抓取窗口后按同一问题集补跑可见性检测，形成发布前后基线，才能开始判断效果。
- 当前真实可见性实验为 `0/100`，说明品牌和域名尚未进入本轮 AI 回答；这不是服务故障，而是当前观测结果。
- 阿里云 ECS 仍无自动续费、无云盘快照、无删除保护，属于独立基础设施风险。
- Nginx 全局存在 `multica` 的重复 MIME warning，与 GEO 无关但应另开运维任务处理。

## 回滚

1. 在 aliyun-hk 移除 `/etc/nginx/sites-enabled/geo-kidshub`，执行 `nginx -t` 后 reload。
2. 在 company-vm 停止并 disable `geo-dashboard-tunnel.service` 与系统级 `geo-engine.service`。
3. 若仅回滚 GEO Release，使用 `cutover-geo-engine-release.sh <old-sha> <new-sha> <old-version>` 恢复旧 Release/venv，并核对对应 SQLite 备份；禁止只回滚代码不核对数据库完整性。
4. 确认 aliyun-hk `127.0.0.1:13808` 消失后，再移除 `geo-tunnel` 的公钥或账号。
5. 如需撤销 API 白名单，恢复 `/root/geo-kidshub-before-v040-20260814-122001.conf` 后执行 `nginx -t` 与 reload；不得覆盖其他站点。
6. TLS 证书可保留至自然到期；删除证书不是回滚站点的必要步骤。
