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
2. 最新阶段验收文档，如 `docs/m2-day5-6-acceptance.md`
3. Studio 实际代码：`ssh studio` → `/Users/fu-121/kidshub-growth/app`

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
- 不使用 Mini，不把业务数据/密钥放 dev198，不动 Studio 现有 Ollama/LiveKit/kidsbench/vision/voice 服务

## GitHub 强制规则

Air 上所有 GitHub 操作显式使用：

```bash
git -c http.proxy=socks5h://127.0.0.1:10808 \
  -c http.version=HTTP/1.1 \
  <git-subcommand>
```

失败时停止，不准直连兜底。push 后检查 `~/xray/access.log` 的 `github.com:443 [socks -> JP-Linode-V1]`。

Studio 不配置 GitHub token；Air push 后使用 Git bundle 离线同步 Studio。

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
ssh studio 'launchctl print gui/$(id -u)/cn.kidshub.insight.web'
ssh studio 'lsof -nP -iTCP:3200 -sTCP:LISTEN'
```

## 当前里程碑

- M1：37 张表与数据层已验收
- M2：登录、数据库 Session、三角色 RBAC、限流、强制改密、Session 吊销、审计与 CSRF 已验收
- 当前正式用户只有 `rayman.chen@futurus.co` root
- 下一步：Day 7 账号管理；不得提前做 Day 8 主数据 CRUD
