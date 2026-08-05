# KidsHub Growth Insight · M2 Day 5–6 验收与经验

> 日期：2026-08-05
> 状态：川哥已完成真实登录体验并确认通过
> 代码仓：`https://github.com/FUTURUS-ProductResearch/kidshub-insight`
> M2 提交：`0c8430448ceebd34f508b3d4d200860bee684930`

## 1. 本阶段交付

- PostgreSQL 数据库 Session，浏览器只保存随机令牌，数据库只保存 SHA-256 哈希
- `root` / `editor` / `viewer` 三角色服务端 RBAC
- 初始密码强制修改，改密后吊销该用户全部 Session
- 同账号 15 分钟内连续 5 次失败后锁定
- 登录成功、失败、锁定、退出、改密写入 append-only `audit_logs`
- Cookie 写接口增加自定义请求头与同源校验，避免 Route Handler CSRF
- 登录页、强制改密页、受保护首页和角色权限摘要
- `cn.kidshub.insight.web` 使用 launchd `KeepAlive + RunAtLoad` 常驻

## 2. 验收证据

| 项目 | 结果 |
|---|---|
| `pnpm build` | 通过，无类型错误和构建警告 |
| `pnpm ops:verify-schema` | 通过 |
| `prisma migrate deploy` | 无待执行迁移 |
| `pnpm ops:verify-m2` | root=200，editor/viewer 越权=403，Session 吊销=401，限流=429，CSRF=403 |
| 负向验证 | 临时注入 editor 越权 bug，验收脚本准确报 `expected 403, got 200` |
| 浏览器验收 | 登录→强制改密→重新登录→首页完整通过，控制台无 error |
| launchd | 强制重启 PID 变化后 HTTP 200，unit 为 running/keepalive/runatload |
| GitHub | Studio 与远端 `main` 均为 `0c843044...`，工作区干净 |

## 3. 经验教训

1. **GitHub 连接必须显式走 xray，失败时不准直连兜底。** 本次直连出现 `SSL_ERROR_SYSCALL`；改用 `socks5h://127.0.0.1:10808` 后稳定，且 access log 证明走 `JP-Linode-V1`。
2. **Studio 不直接访问 GitHub。** Studio 没有 GitHub 凭据，也没有本机 xray 出口；正确链路是 Air 通过 xray push，再用 Git bundle 离线快进 Studio。
3. **Edge middleware 不能间接 import Node-only 模块。** `middleware.ts` 引入 auth 聚合模块后把 `node:crypto` 打进 Edge bundle，构建失败；应把 Cookie 名等边缘安全常量拆成独立模块。
4. **Next.js Route Handler 的 Cookie 认证写接口必须显式做 CSRF。** `SameSite=Lax` 只是纵深防御；本项目采用自定义请求头 + Origin/Host 同源校验。
5. **验证查询必须匹配数据库真实对象。** Prisma 的唯一键在验收时应查 `pg_indexes`；误查 `pg_constraint` 会得到空结果，却不代表约束不存在。
6. **检查脚本必须用真实 bug 做负向验证。** 只有亲手让 editor 越权并看到脚本变红，才能证明三角色 403 不是自证循环。
7. **SSH 临时启动的长进程可能在会话结束后成为孤儿。** 临时测试结束应按端口取证后精确停 PID；正式体验必须交给 launchd，不使用模糊 `pkill`。
8. **密码输入不能依赖普通 TTY。** 普通 TTY 会回显；交互输入应先 `stty -echo`，或使用读取一行后通过 stdin 管道传给脚本，密码不进命令行、文件或 Git。
9. **视觉验收也要检查浏览器控制台。** favicon 404 和密码表单缺 username 虽不阻断功能，但会污染体验和可访问性，均应在交付前清零。

## 4. Day 7 边界

只实现 root 可用的账号管理入口：创建 editor/viewer、启用/禁用、调整角色、吊销 Session。不得提前进入 Day 8 主数据 CRUD。

Day 7 验收必须覆盖：

- root 创建 editor/viewer 成功
- editor/viewer 访问账号管理接口均返回 403
- 禁用账号后现有 Session 立即失效
- 修改角色后旧 Session 立即失效并要求重新登录
- root 可吊销指定用户全部 Session
- 不允许禁用、降级或删除系统最后一个 active root
- 所有账号写操作产生审计记录
- 负向注入一个真实越权/最后 root 保护 bug，确认验收脚本变红
