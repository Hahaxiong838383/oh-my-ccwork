# GEO 公网只读 Dashboard 部署验收

日期：2026-08-14（Asia/Shanghai）

## 结论

`https://geo.kidshub.cn/` 已上线 GEO Engine `0.3.1` 新版 Control Room。前后端均来自上游 Commit `5c7a9e5c3676e8e11aaaab112e416e6b8d38d50d`；公网入口采用独立认证、精确只读路由和受限反向 SSH，GEO 原始无鉴权写 API、公司虚拟机 `8080` 和阿里云回环端口均未直接暴露公网。

GEO 主进程已迁入系统级 systemd，代码使用不可变 Git Release 和独立 venv，监听固定为 `127.0.0.1:8080`，模型 Key 仅由 `0600` EnvironmentFile 注入。本次迁移没有修改知识库、文章、可见性记录或发布状态；SQLite 迁移前后数据计数一致且 `integrity_check=ok`。

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
- Nginx 只代理 `/`、`/dashboard` 和公开只读 `/health`；其余 API 路径返回 `404`，非 GET/HEAD 方法返回 `405`。
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

### company-vm

- 上游 Commit：`5c7a9e5c3676e8e11aaaab112e416e6b8d38d50d`
- 当前 Release：`/home/futurus/.geo-engine/releases/company-ai-ontology-5c7a9e5c3676e8e11aaaab112e416e6b8d38d50d`
- 当前代码指针：`/home/futurus/.geo-engine/current`
- 独立 venv：`/home/futurus/.geo-engine/venvs/geo-engine-5c7a9e5c3676e8e11aaaab112e416e6b8d38d50d`
- Git Bundle SHA-256：`8f5f72539210df64f000ec8ab2f4f564d83a11cbd913d13a6cd1fccd5de64300`
- GEO 系统服务：`/etc/systemd/system/geo-engine.service`
- GEO EnvironmentFile：`/home/futurus/.config/geo-engine/geo-engine.env`，权限 `0600`
- GEO 数据：`/home/futurus/.geo-engine/geo_engine.db`
- 隧道服务：`/etc/systemd/system/geo-dashboard-tunnel.service`
- 隧道密钥目录：`/home/futurus/.geo-engine/tunnel/`
- 切换备份：`/home/futurus/.geo-engine/backups/systemd-cutover-20260814-105641`
- GEO 运行读数：4 个知识库、906 个切片、7 篇文章、5 篇已审核、平均分 `83.9`、9 条可见性记录。

GitHub 组织策略禁止该仓库使用 Deploy Key，因此没有把个人 Token 或私钥复制到服务器。部署流程由本机已授权 GitHub 会话 `fetch` 最新主线，生成含完整历史的 Git Bundle，校验 SHA-256 后传入 company-vm 并创建可审计 Git Release；服务器 Release 的 `HEAD` 与 GitHub `main` 完全一致。后续更新继续使用同一 Bundle 流程，除非组织另行批准机器身份凭据。

可重复运维资产位于 `deploy/company-vm/`：`geo-engine.service`、`geo-dashboard-tunnel.service` 和 `activate-geo-engine-release.sh`。激活脚本只接受已准备并校验完成的 Release SHA，先备份旧源码、SQLite 和 unit，再安装系统单元与 current 指针；它不读取或打印 Secret。

## 验收证据

| 验收项 | 结果 |
|---|---|
| DNS A 记录 | `8.218.26.17` |
| 未认证首页 | `401` |
| 认证后 Dashboard | `200`，HTML `32102` bytes |
| Dashboard 标题 | `GEO Control Room · 爱视可` |
| `/health` | `200` |
| `/stats`、`/kb`、`/articles`、`/publish` | `404` |
| POST/PUT/DELETE/PATCH | `405` |
| TLS SAN | `geo.kidshub.cn` |
| Certbot renew dry-run | 成功 |
| 外部访问 `13808` | filtered/timeout |
| 隧道重启恢复 | active，`NRestarts=0` |
| 连续公网请求 | 3/3 返回 `200` |
| 前端/后端数据一致性 | 4 个知识库、906 个切片、7 篇文章、9 条可见性记录完全一致 |
| 桌面 Chromium | `1440px`，无横向溢出，4 个指标/7 篇文章/9 条历史记录正确 |
| 移动 Chromium | iPhone `393px`，无横向溢出，关键卡片和数据完整 |
| 浏览器控制台 | `0` 错误、`0` 警告 |
| systemd 依赖重启 | GEO 与隧道同时重启通过，双方 `NRestarts=0` |
| company-vm LAN `8080` | 不可达，仅回环监听 |
| Nginx GEO error log | 空 |

真实浏览器验收使用项目本地 Playwright Chromium，完成桌面与移动布局、数据渲染、刷新后恢复和控制台检查；验收后二进制与临时认证配置不进入 Git。

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

## 当前遗留门禁

- Basic Auth 是第一阶段独立认证；若进入多人使用，应接入 H 管理员认证或公司统一身份体系。
- GEO Dashboard 会在认证后的 HTML 内嵌当前文章、任务、知识库和可见性数据；不得改成公开无认证站点。
- 阿里云 ECS 仍无自动续费、无云盘快照、无删除保护，属于独立基础设施风险。
- Nginx 全局存在 `multica` 的重复 MIME warning，与 GEO 无关但应另开运维任务处理。

## 回滚

1. 在 aliyun-hk 移除 `/etc/nginx/sites-enabled/geo-kidshub`，执行 `nginx -t` 后 reload。
2. 在 company-vm 停止并 disable `geo-dashboard-tunnel.service` 与系统级 `geo-engine.service`。
3. 从 `/home/futurus/.geo-engine/backups/systemd-cutover-20260814-105641` 恢复旧 user unit、旧源码和 SQLite 备份，再启用旧 user service；禁止只回滚代码不核对数据库完整性。
4. 确认 aliyun-hk `127.0.0.1:13808` 消失后，再移除 `geo-tunnel` 的公钥或账号。
5. 如需恢复 Nginx 发布前真值，参考 `/root/nginx-before-geo-20260814-100133.conf`，但禁止整文件盲覆盖其他站点的后续变更。
6. TLS 证书可保留至自然到期；删除证书不是回滚站点的必要步骤。
