# GEO 公网只读 Dashboard 部署验收

日期：2026-08-14（Asia/Shanghai）

## 结论

`https://geo.kidshub.cn/` 已上线 GEO Engine `0.3.1` 运营监控台。公网入口采用独立认证、精确只读路由和受限反向 SSH；GEO 原始无鉴权写 API、公司虚拟机 `8080` 和阿里云回环端口均未直接暴露公网。

本次只部署前端访问链路，没有修改 GEO SQLite 数据库、知识库、文章、可见性记录或发布状态。

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

- GEO Engine：`/home/futurus/geo-engine`
- GEO 数据：`/home/futurus/.geo-engine/geo_engine.db`
- 隧道服务：`/etc/systemd/system/geo-dashboard-tunnel.service`
- 隧道密钥目录：`/home/futurus/.geo-engine/tunnel/`
- GEO 运行读数：4 个知识库、906 个切片、7 篇文章、5 篇已审核、平均分 `83.9`、9 条可见性记录。

## 验收证据

| 验收项 | 结果 |
|---|---|
| DNS A 记录 | `8.218.26.17` |
| 未认证首页 | `401` |
| 认证后首页 | `200`，HTML `18500` bytes |
| Dashboard 标题 | `GEO Engine 运营监控台` |
| `/health` | `200` |
| `/stats`、`/kb`、`/articles`、`/publish` | `404` |
| POST/PUT/DELETE/PATCH | `405` |
| TLS SAN | `geo.kidshub.cn` |
| Certbot renew dry-run | 成功 |
| 外部访问 `13808` | filtered/timeout |
| 隧道重启恢复 | active，`NRestarts=0` |
| 连续公网请求 | 3/3 返回 `200` |
| Dashboard 内联 JS 语法 | 1/1 通过 |
| Nginx GEO error log | 空 |

本机未预装 Playwright CLI，按依赖本地化规则未临时安装；本次前端验收使用真实 HTTPS、认证、响应体、脚本语法、连续请求和隧道恢复证据。后续发生 UI 改版时仍应补真实浏览器控制台、布局和移动端验收。

## 经验教训

1. **DNS 生效不等于 HTTPS 可用**：部署前 `geo.kidshub.cn` 已指向正确 IP，但因为没有独立 Nginx `server_name` 和证书，TLS 命中了 ERP 默认证书。
2. **无鉴权 Dashboard 不能直接反代**：GEO 原始服务同时包含文章详情、知识库、生成、发布和可见性写接口；公网必须使用精确路径白名单，不能把整个 `8080` 透传。
3. **反向端口必须绑定回环**：阿里云回环监听、受限 `permitlisten`、安全组无对应端口和公网探针四项要同时成立。
4. **隧道 active 不等于页面可用**：验收必须覆盖公司机 `/health`、阿里云回环 Dashboard、公网认证页面和隧道真实重启恢复。
5. **凭据应与业务系统隔离**：GEO 独立访问凭据不复用 H 管理员密码、Ontology 密码或模型 API Key，Hash 与明文分开保存。
6. **证书发布必须带续期证据**：首次签发成功后立即执行指定证书的无随机延迟 dry-run，避免把“当前可用”误报为“可持续运行”。

## 当前遗留门禁

- GEO Engine 主进程仍由手工启动与 crontab 兜底，尚未迁入正式 systemd 服务。
- GEO Engine 当前监听 `0.0.0.0:8080`；虽被公司机 UFW 阻断，后续应收紧为 `127.0.0.1:8080`。
- Basic Auth 是第一阶段独立认证；若进入多人使用，应接入 H 管理员认证或公司统一身份体系。
- GEO Dashboard 会在认证后的 HTML 内嵌当前文章、任务、知识库和可见性数据；不得改成公开无认证站点。
- 阿里云 ECS 仍无自动续费、无云盘快照、无删除保护，属于独立基础设施风险。
- Nginx 全局存在 `multica` 的重复 MIME warning，与 GEO 无关但应另开运维任务处理。

## 回滚

1. 在 aliyun-hk 移除 `/etc/nginx/sites-enabled/geo-kidshub`，执行 `nginx -t` 后 reload。
2. 在 company-vm 停止并 disable `geo-dashboard-tunnel.service`。
3. 确认 aliyun-hk `127.0.0.1:13808` 消失后，再移除 `geo-tunnel` 的公钥或账号。
4. 如需恢复 Nginx 发布前真值，参考 `/root/nginx-before-geo-20260814-100133.conf`，但禁止整文件盲覆盖其他站点的后续变更。
5. TLS 证书可保留至自然到期；删除证书不是回滚站点的必要步骤。
