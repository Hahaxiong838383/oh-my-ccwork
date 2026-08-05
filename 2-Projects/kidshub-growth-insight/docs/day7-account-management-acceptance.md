# KidsHub Growth Insight Day 7 验收记录

> 日期：2026-08-05
> 结论：Day 7 账号管理已完成、部署、自动验收并由川哥真实体验通过。下一阶段为 Day 8–11 / M3 主数据管理。

## 1. 交付范围

- root 专属 `/admin/users` 账号管理入口。
- 创建 `editor` / `viewer`，初始密码仅在请求内处理并以 Argon2id 入库。
- 修改显示名称、角色、启用/禁用状态。
- 吊销指定用户全部有效 Session。
- 角色或状态变化后立即吊销目标用户旧 Session。
- 禁止修改当前登录账号自身的角色或状态。
- 保证系统至少保留一个 active root。
- 所有成功写操作进入 append-only 审计日志。
- editor / viewer 对账号管理页面和接口均为服务端 403。

## 2. 自动验收

Studio 最终回归：

```text
schema verification passed
M2 verification passed
Day 7 verification passed
{"root":200,"editor":403,"viewer":403,"disabledSession":401,"roleChangedSession":401,"revokedSession":401,"selfProtection":409}
```

构建通过，Studio Git 工作区干净，运行提交：

```text
2e7d349861e091a08c2f5b013ebbea41ea05fa01
```

生产状态：

- `cn.kidshub.insight.web` 为 `running`。
- `3200` 由正式 Node 进程监听。
- 数据库只保留 1 个 active root 和 1 个有效 Session。
- `web.err.log` 只有启动命令回显，无应用错误堆栈。

## 3. 负向验证

临时把创建账号权限错误地开放给 editor 后，`ops:verify-day7` 准确失败：

```text
editor create user expected 403
```

恢复正确权限后，Day 7 与 M2 回归全部通过。负向注入未进入提交。

## 4. 浏览器验收

真实完成：登录 → 账号管理 → 创建 viewer → 禁用 viewer。修复后表单会重置、显示成功提示并刷新账号列表。

体验入口：`http://192.168.61.177:3200/admin/users`

## 5. 经验教训

1. **权限必须在 Route Handler 上判定。** 隐藏按钮只能改善体验，不能构成授权边界。
2. **角色和状态变化必须同步吊销 Session。** 否则旧 Cookie 会继续保留变更前权限。
3. **最后一个 root 保护要放进 Serializable 事务。** 先计数再更新但不锁定事务，会留下并发竞态。
4. **异步表单不要在 `await` 后读取 `event.currentTarget`。** React 事件上下文可能已失效；请求前保存表单元素引用。
5. **验收脚本要覆盖旧 Session 的真实失效。** 只查数据库字段变化不能证明线上授权已立即收紧。
6. **离线 Git 同步要核对 untracked 文件。** 比较 stash 与提交补丁时必须使用 `git stash show --include-untracked`，否则会把完整变更误判为不一致。
7. **xray 链路瞬断只允许同代理重试。** 本次 push 成功后 `ls-remote` 两次 TLS 瞬断，第三次仍经相同 xray 路径成功；禁止移除代理直连兜底。

## 6. 下一步边界

只进入 Day 8–11 / M3：品类、品牌、关键词、达人、商品 CRUD 与 `entity_aliases` 合并；不提前做 Day 12 数据源和 Token。
