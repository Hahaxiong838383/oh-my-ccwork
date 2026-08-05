---
name: kidshub-growth-insight
description: KidsHub Growth Insight 项目开发、部署与验收指南。用户提到 KidsHub Growth Insight、insight.kidshub.cn、Studio 上的投流情报系统、37 张表、M1/M2/M3、达人竞品情报或项目 Day 计划时使用。
layer: 项目层
authorization: B区（Studio 生产变更需用户明确授权）
output_levels: L2
---

# KidsHub Growth Insight

## 先读真源

1. `~/mycc/2-Projects/kidshub-growth-insight/docs/architecture-v0.4.md`
2. 最新阶段验收文档：`docs/mediacrawler-public-access-acceptance.md`
3. 后续清单：`docs/next-todos.md`
4. Studio 实际代码：`ssh studio` → `/Users/fu-121/kidshub-growth/app`

不根据旧摘要猜路径、版本、端口、表数或运行状态；每次先实测。

## 固定边界

- 部署机：Studio，用户 `fu-121`
- 代码：`/Users/fu-121/kidshub-growth/app`
- 数据：`/Users/fu-121/kidshub-growth/data`
- 日志：`/Users/fu-121/kidshub-growth/logs`
- 密钥：`/Users/fu-121/kidshub-growth/secrets`，目录 700，密钥文件 600
- Web：`3200`
- PostgreSQL 17：`127.0.0.1:5432`
- GitHub：`FUTURUS-ProductResearch/kidshub-insight`
- 公网入口：`https://insight.kidshub.cn`
- 不使用 Mini，不把业务数据/密钥放 dev198，不动 Studio 现有 Ollama/LiveKit/kidsbench/vision/voice 服务

## 公网入口规则

- 正式入口不使用 Cloudflare Quick Tunnel，不交付任何 `trycloudflare.com` URL。
- 当前链路：域名直达 aliyun-hk Nginx，再通过只监听回环地址的受限反向 SSH 到 Studio 3200。
- Error 1016/1033 先归因 Cloudflare 域名/隧道层；不要在 Next.js、PostgreSQL 或业务数据层盲改。
- 公网验收至少从 Air 和一个独立公网节点连续多轮请求，并完成登录后的真实业务页面。
- 临时进程按端口定位后精确停止 PID，禁止宽泛 `pkill -f cloudflared`。
- 公网用户入口与 Studio 运维入口分离；用户页面可用不能替代 SSH 运维验收。
- 只有 Studio 公网 IPv6或路由器端口映射、443、防火墙、TLS、重启恢复全部实测通过，才允许把域名直接切到 Studio。

## GitHub 强制规则

Air 上所有 GitHub 操作显式使用：

```bash
git -c http.proxy=socks5h://127.0.0.1:10808 \
  -c http.version=HTTP/1.1 \
  <git-subcommand>
```

失败时停止，不准直连兜底。push 后检查 `~/xray/access.log` 的 `github.com:443 [socks -> JP-Linode-V1]`。

Studio 不配置 GitHub token；Air push 后使用 Git bundle 离线同步 Studio。

Studio 已有未提交部署文件时，先 `git stash push -u`，从 bundle 快进后用
`git stash show --include-untracked --binary -p` 与目标提交完整补丁比对；一致后再丢弃 stash。
不能用默认 `git stash show -p` 做完整性判断，因为它不包含 untracked 文件。

## 施工纪律

1. 一次只做蓝图当前 Day，不顺手进入下一阶段。
2. 任何检查脚本都要注入一个真实 bug，确认变红后恢复并正向全绿。
3. 生产数据库迁移只用 `prisma migrate deploy`，代码和脚本禁止出现危险的开发迁移命令。
4. Cookie 认证写接口必须服务端鉴权、角色校验、CSRF 校验和审计；前端隐藏按钮不算权限。
5. 密码只从 stdin 输入，不进参数、文件、Git、记忆或日志。
6. 临时进程结束后按端口查 PID 并精确停止；正式体验用 launchd。
7. 验收同时包含真实浏览器流程和独立服务端/数据库/日志证据。

## 常用验收

```bash
ssh studio 'cd /Users/fu-121/kidshub-growth/app && pnpm build'
ssh studio 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-schema'
ssh studio 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-m2'
ssh studio 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-day7'
ssh studio 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-m3'
ssh studio 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-m4'
ssh studio 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-m5'
ssh studio 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-m55'
ssh studio 'launchctl print gui/$(id -u)/cn.kidshub.insight.web'
ssh studio 'lsof -nP -iTCP:3200 -sTCP:LISTEN'
/usr/bin/curl --noproxy '*' -sS -o /dev/null -w 'HTTP=%{http_code} TOTAL=%{time_total}\n' https://insight.kidshub.cn/login
```

## 当前里程碑

- M1：37 张表与数据层已验收
- M2：登录、数据库 Session、三角色 RBAC、限流、强制改密、Session 吊销、审计与 CSRF 已验收
- Day 7：root 账号管理、角色/状态变更吊销 Session、最后 active root 保护已验收
- M3：五类主数据 CRUD、软删除/root 恢复、达人/商品跨源别名合并已由川哥体验验收
- M4：数据源、配额、JustOneAPI Token 真实校验、不回显、脱敏和本地密钥文件已完成
- M5：CSV / Excel 数据导入管线已完成
- M5.5：MediaCrawler 小红书/抖音研究采集已完成
- M5.6：采集结果详情页与固定公网入口已由川哥真实体验验收
- 当前正式用户只有 `rayman.chen@futurus.co` root
- 当前正式主数据仍为空，等待川哥手动录入
- 当前正式数据源和 Token 仍为空，等待川哥体验
- 当前业务提交：`0f965dae2b7ba6ad8f470c2209606adf04ac23af`
- 下一步按 `docs/next-todos.md` 从 P0 采集可靠性与结果完整性推进，每阶段仍需用户验收后再继续

## 验收脚本自检

- 负向验证必须确认具体失败断言命中注入缺陷，不能只看 exit code 非零。
- 预期失败的请求也必须携带 run-specific 清理标识；真实 bug 会让“本应失败”的写入成功。
- API 与 HTML 页面混合验收时按 `content-type` 解析，不能把任意 200 响应都 `JSON.parse`。
- 软删除恢复权限要检查所有可复活路径，尤其 upsert/create-on-conflict，不能只守 `/restore`。
- Token 验收必须同时覆盖真实无效端点和隔离有效 mock；不能因没有付费 Token 就省略成功路径。
- 日志泄密检查前先 `which grep/rg`，工具不存在时的空输出不构成 0 命中证据。
- Provider 校验器未接入时必须拒绝保存 Token，不能把 pending 当成安全兜底。
- Quick Tunnel 随机域名出现一次 200 不代表稳定；必须验证固定入口、真实登录、业务结果和跨网络连续采样。
- `ssh studio` 在非公司局域网可能不可达；阴性结果只能说明当前运维路径不可用，不能据此判定 Studio Web 服务或反向入口故障。
