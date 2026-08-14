# GEO 公网受控操作台部署验收

日期：2026-08-14（Asia/Shanghai）

## 结论

`https://geo.kidshub.cn/` 已上线 GEO Engine `0.4.1` 动态 API Control Room。当前生产 Release 锚定 Commit `4cade6c6a459ed3c4c6d6ed615cd7999f7b6b585`；公网入口采用独立认证、精确路由白名单和受限反向 SSH，公司虚拟机 `8080` 和阿里云回环端口均未直接暴露公网。

GEO 主进程由系统级 systemd 托管，使用固定 Git Release 和独立 venv，监听固定为 `127.0.0.1:8080`，模型 Key 仅由 `0600` EnvironmentFile 注入。前端不再嵌入服务端快照，而是从正式域名动态读取 API；公网写操作继续使用 Basic Auth、精确路由、方法限制、请求体上限、限流和分接口超时，不开放整个上游端口。SQLite 当前为 4 个知识库、906 个切片、7 篇文章、12 条可见性记录、5 条实验且 `integrity_check=ok`。

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
- Nginx 公开只读 `/health`；认证后允许 GET `/`、`/dashboard`、`/stats`、`/kb`、`/articles`、`/visibility/history`、`/meta`、`/experiments`，以及 POST `/visibility`、`/audit`、`/articles/update`、`/publish`、`/gen`、`/kb/create`、`/kb/add`、`/fix`、`/visibility/multi`。其余路径返回 `404`，非允许方法返回 `405`。
- 七个新增写接口共用 `geo_operations` 限流区：`rate=6r/m`、`burst=2`。连续批量验收可能暂时返回 `503`，应串行探测或等待令牌恢复，不能误判为后端故障。
- `/articles/update` 限制 `2m/60s`，`/publish` 为 `120s`，`/gen` 为 `16k/600s`，`/kb/create` 为 `16k/60s`，`/kb/add` 为 `5m/120s`，`/fix` 为 `16k/90s`，`/visibility/multi` 为 `16k/900s`。
- `/publish` 与 `/fix` 后端允许调用方指定输出目录，Basic Auth 凭据因此属于高权限运维凭据；不得分享给普通访客、写入前端、Git、日志或协作消息。
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
- 当前 Nginx 配置 SHA-256：`edbf186c7cab5f5d7510b3a8ba52ec4e30b381275939c13a49019dee3c63ae50`

### company-vm

- 上游 Commit：`4cade6c6a459ed3c4c6d6ed615cd7999f7b6b585`
- 当前 Release：`/home/futurus/.geo-engine/releases/company-ai-ontology-4cade6c6a459ed3c4c6d6ed615cd7999f7b6b585`
- 当前代码指针：`/home/futurus/.geo-engine/current`
- 独立 venv：`/home/futurus/.geo-engine/venvs/geo-engine-4cade6c6a459ed3c4c6d6ed615cd7999f7b6b585`
- GEO 系统服务：`/etc/systemd/system/geo-engine.service`
- GEO EnvironmentFile：`/home/futurus/.config/geo-engine/geo-engine.env`，权限 `0600`
- GEO 数据：`/home/futurus/.geo-engine/geo_engine.db`
- 隧道服务：`/etc/systemd/system/geo-dashboard-tunnel.service`
- 隧道密钥目录：`/home/futurus/.geo-engine/tunnel/`
- 首次 systemd 切换备份：`/home/futurus/.geo-engine/backups/systemd-cutover-20260814-105641`
- `0.3.2` 模型/发布状态切换备份：`/home/futurus/.geo-engine/backups/model-publish-v032-20260814-113147`
- `0.4.0` API/实验账本切换备份：`/home/futurus/.geo-engine/backups/api-console-v040-20260814-121834`
- `0.4.1` 上海时区修复备份：`/home/futurus/.geo-engine/backups/timezone-v041-20260814-122512`
- GEO 运行读数：4 个知识库、906 个切片、7 篇文章、2 篇草稿、5 篇已审核待发布、0 篇仅导出、0 篇公开发布、12 条可见性记录、5 条实验记录。
- 当前资料包版本：`kbp-6adb88da8625`，148,793 tokens。
- 生成配置：`GEO_GENERATION_MODEL=deepseek-v4-flash`、`GEO_REASONING_EFFORT=max`。

GitHub 组织策略禁止该仓库使用 Deploy Key，因此没有把个人 Token 或私钥复制到服务器。标准部署流程由本机已授权 GitHub 会话 `fetch` 主线，生成含完整历史的 Git Bundle，校验 SHA-256 后传入 company-vm 并创建可审计 Git Release。当前生产 Release 的 `HEAD` 仍为 `4cade6c`，但工作树已有协作者热更新：`content/generator.py`、`server/api.py`、`server/dashboard.py` 被修改，且存在未跟踪的 `build/` 与 `geo_engine.egg-info/`；下一次切换前必须把有效改动收敛进 Git，从最终 Commit 重建 clean Release，禁止直接覆盖或清理现场。

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
| GET 七个新增写接口 | 全部 `405` |
| POST 七个新增写接口空 JSON | 全部到达后端并返回对应缺参 `400` |
| 未知 `/admin/delete-all` | `404` |
| TLS SAN | `geo.kidshub.cn` |
| Certbot renew dry-run | 成功 |
| 外部访问 `13808` | filtered/timeout |
| 隧道重启恢复 | active，`NRestarts=0` |
| 连续公网请求 | 3/3 返回 `200` |
| 前端/后端数据一致性 | 4 个知识库、906 个切片、7 篇文章、12 条可见性记录、5 条实验记录完全一致 |
| 生成模型 | `deepseek-v4-flash`，最高推理 `max` |
| 发布状态 | 2 篇草稿、5 篇已审核待发布、0 篇仅导出、0 篇公开发布 |
| 资料包版本 | `kbp-6adb88da8625`，4 个知识库、906 个切片、148,793 tokens |
| AI 可见性操作 | 爱视可/`eyescare.cn`：`0/100`、品牌提及 `0/6`、域名引用 `0/6`，实验 #2 |
| 网站审计操作 | `ai.kidshub.cn` 登录页 smoke：`19/100`、D、21 项问题，实验 #1 |
| Tab active | 总览、AI 可见性、网站审计、内容资产、知识库、实验记录六项逐项一致 |
| 桌面浏览器 | `1440px`，无横向溢出，动态 API、操作结果和上海时间正确 |
| 移动浏览器 | iPhone `393px`，无横向溢出，Tab 与操作表单完整 |
| 浏览器控制台 | `0` 错误、`0` 警告 |
| systemd 依赖重启 | GEO 与隧道同时重启通过，双方 `NRestarts=0` |
| company-vm LAN `8080` | 不可达，仅回环监听 |
| Nginx GEO error log | 空 |

真实浏览器验收使用项目本地 Playwright WebKit，完成桌面与移动布局、六个 Tab active、动态 API、真实网站审计、真实 AI 可见性检测、实验账本、上海时间和控制台检查；验收后二进制、截图与临时认证配置不进入 Git。

## 如何判断文章是否发布、是否有效

Dashboard 的文章状态采用以下口径：

- `草稿`：文章仅生成，尚未通过人工审核。
- `已审核 · 待发布`：人工审核通过，但没有向外部平台交付，不等于已经发布。
- `已导出 · 未公开`：已生成静态 HTML/Markdown 文件，但没有公开 URL，公网和搜索引擎仍不可见。
- `已公开`：外部发布平台成功返回公开 URL，并记录发布时间、平台和链接；只有该状态才算真正发布。

效果判断必须在文章公开后继续运行 AI 可见性检测，观察发布前后同一批问题的可见性分数、品牌提及次数、品牌域名引用次数和竞品信号变化。单篇文章与品牌整体变化之间只能作为相关性线索，不能直接宣称因果；当前公开发布数为 `0`，所以现在还不能判断发布效果。

## 经验教训

1. **DNS 生效不等于 HTTPS 可用**：部署前 `geo.kidshub.cn` 已指向正确 IP，但因为没有独立 Nginx `server_name` 和证书，TLS 命中了 ERP 默认证书。
2. **无鉴权 Dashboard 不能直接反代**：GEO 原始服务同时包含文章详情、知识库、生成、发布和可见性写接口；公网必须使用精确路径白名单，不能把整个 `8080` 透传。
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

## 当前遗留门禁

- Basic Auth 是第一阶段独立认证；若进入多人使用，应接入 H 管理员认证或公司统一身份体系。
- GEO Dashboard 会在认证后的 HTML 内嵌当前文章、任务、知识库和可见性数据；不得改成公开无认证站点。
- 当前 5 篇审核文章尚未公开发布；未经业务确认不得自动向外部平台发布。
- 首篇公开发布后需按同一问题集补跑可见性检测，形成发布前后基线，才能开始判断效果。
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
