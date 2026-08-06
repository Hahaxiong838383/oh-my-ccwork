# 爱视可 ERP 公网发布方案 V0.2

> 上线日期：2026-08-06

## 1. 当前入口

- 正式公网地址：`https://erp.hahaxiong.cc`
- 旧调试地址：`https://aishike-erp.8-218-26-17.sslip.io`，保留 301 跳转和回滚能力
- 日常管理员账号：`rayman.chen@futurus.co`；后续员工系统账号必须统一使用 `@futurus.co` 飞书企业邮箱。
- 应急账号：`Administrator` 仅用于恢复；密码只保存在 `company-vm:/home/futurus/aishike-erp/deploy/secrets/admin_password.txt`，不得写入文档、Git、日志或聊天。

`erp.hahaxiong.cc` 使用阿里云 DNS 显式 A 记录解析到香港入口 `8.218.26.17`。旧 `sslip.io` 域名继续持有有效证书，但 HTTPS 请求统一 301 跳转到正式域名。

## 2. 网络拓扑

```text
公网浏览器
  -> HTTPS erp.hahaxiong.cc
  -> aliyun-hk Nginx :443
  -> 127.0.0.1:13281
  -> company-vm 主动建立的受限反向 SSH
  -> 127.0.0.1:18080
  -> ERPNext/Frappe frontend
```

安全边界：

- 公司虚拟机 ERP 容器继续只监听 `127.0.0.1:18080`；
- 香港反向转发端口只监听 `127.0.0.1:13281`；
- 香港使用独立低权限账号 `aishike-tunnel`，项目独立 ED25519 密钥只允许指定远程监听；
- 公网仅开放香港 Nginx 的 80/443，HTTP 强制跳转 HTTPS；
- Nginx 对登录接口限速，设置 `X-Robots-Tag: noindex`，不允许搜索引擎收录；
- WebSocket 使用内部 `X-Frappe-Site-Name=aishike.localhost` 路由站点，使用 `X-Forwarded-Host` 校验公网 Origin。

## 3. 持久化与恢复

- `deploy/public-tunnel.sh`：单次受限反向 SSH；
- `deploy/public-tunnel-supervisor.sh`：断线后 5 秒重连，PID 和日志位于 `deploy/runtime/`；
- 用户 crontab `@reboot`：公司虚拟机重启后恢复 supervisor；
- `deploy/public-doctor.sh`：检查 supervisor PID、公网 ping 和登录页状态；
- 正式域名 Let’s Encrypt 证书到期时间：2026-11-04，香港 Certbot 自动续期任务已启用且 dry-run 成功。

## 4. 验收证据

- 香港回环 `127.0.0.1:13281` 返回 ERP `pong`；
- 本机指定香港入口连续 10/10 次公网 ping 成功；浏览器通过正式域名真实访问成功；
- `aliyun-kr` 连续 10/10 次公网 ping 成功；
- 正式域名 HTTP 返回 301 并跳转正式 HTTPS；旧调试域名 HTTPS 返回 301 到正式域名；
- TLS 证书 SAN 与公网域名一致；
- 使用真实 `Administrator` 登录公网 SKU 页面成功；
- SKU 页面显示已验收的 Sheet1 数据，Socket.IO 已连接，浏览器控制台 0 错误；
- `deploy/doctor.sh` 与 `deploy/public-doctor.sh` 均为 `ok`。

## 5. 安全事件与修复

首次公网自动化登录时，Playwright 快照意外记录了管理员密码。发现后立即：

1. 关闭浏览器会话；
2. 轮换管理员密码；
3. 清理包含旧密码的本地浏览器产物；
4. 验证新密码未进入截图和 Playwright 文件；
5. 重新完成公网登录与控制台验收。

Docker Secret 使用绑定文件 inode。原子替换宿主机密码文件后，运行中容器仍可能读取旧 inode；密码轮换后必须把新文件安全复制到容器执行密码更新，或重建容器，再执行真实登录验证。

## 6. 回滚

- 公司虚拟机 crontab 备份位于 `deploy/backups/crontab-before-public-*.txt`；
- 香港 Nginx 上线前备份位于 `/var/backups/aishike-erp-public-20260806-221030`；
- 正式域名切换前香港 Nginx 备份位于 `/var/backups/aishike-erp-domain-20260806-225531`；
- 停止隧道时必须读取 `deploy/runtime/public-tunnel-supervisor.pid` 并核对命令后精确结束，禁止使用模糊 `pkill -f`；
- 删除香港 `/etc/nginx/sites-enabled/aishike-erp` 并 reload Nginx 即可关闭公网入口，不影响公司虚拟机局域网和原 SSH 隧道访问；
- DNS 回滚时删除或停用 `erp.hahaxiong.cc -> 8.218.26.17` 的显式 A 记录，域名会重新命中原有通配记录；执行前必须先恢复旧入口的代理配置，避免回滚后不可访问。
