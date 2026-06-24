# 41 · KidsHub 运营台 guest 只读游客账号 —— 三层权限门控

> 川哥 2026-06-24：给 kidshub 运营台加游客账号 `guest` / `123456`，用于查看所有内容、只有读权限、无编辑权限。
> 本文记录运营台现状评估、三层门控方案、实施、双门验证与部署回滚。已部署生产 `kidshub-ai.hahaxiong.cc/admin`，commit `93dcd9043`。

## 一、需求与定位

给一个**已有单账号鉴权**的运营后台加"只读游客账号"：游客能登录看全部内容，但任何编辑操作（增删改）都不允许。川哥拍板可见范围 = **看到和管理员一样的全部页面**（含 mock 演示页），只是全部只读。

## 二、运营台现状（实施前评估，已验证）

- **运营台本体** = 独立静态页 `apps/web/public/admin/index.html`（Vue3 + ElementPlus + ECharts 单文件，**非 React app**）；生产 = `/opt/p003/web/dist/admin/index.html`，nginx 静态直出 `kidshub-ai.hahaxiong.cc/admin`。
- **鉴权机制**：`routes/auth.ts` — `STUDIO_USER`/`STUDIO_PASS` 单账号，`/login` 校验后发内存 token；`admin-data` / `feedback` / `conversation` 路由用 `isValidToken` 中间件（Bearer token）。
- **真实数据 tab** = 「KidsHub 运营台」（孩子档案 `/api/admin/profiles` + 邀请码 `/api/admin/invites` + 反馈 `/api/feedback` + 对话 `/api/conversation`）；其余（用户列表 / SN 订单 / 客服工单 / 数据概览）是 mock 演示页（页面自标"其余看板演示"）。
- **写操作清单（6 个真实编辑入口）**：生成邀请码（POST）/ 删除邀请码（DELETE）/ 改家长昵称（PATCH）/ 重置今日限额（POST）/ 反馈改状态（PATCH）/ 反馈存备注（PATCH）。
- **意外利好**：admin 页早预留了 `isAdmin` 脚手架（`currentUser.role` + `computed`），只是登录后写死 `role='admin'`、头部标签也预留了"B端用户"分支 → 改动量小。

## 三、方案：三层权限门控

| 层 | 机制 | 作用 |
|---|---|---|
| ① 后端 403（**真防线**） | `auth.ts` 加 guest 账号 + token 关联 role；`admin-data` / `feedback` 中间件加 **`if (method!=='GET' && role!=='admin') → 403 forbidden_readonly`** | guest 即使绕过前端直接 curl 也改不了任何数据。**按 HTTP method 在中间件统一门控，一处搞定该路由所有写接口** |
| ② 前端隐藏（仅 UX） | 6 个编辑入口 `v-if="isAdmin"` / `:disabled="!isAdmin"` | guest 看不到编辑按钮 |
| ③ JS guard（纵深） | 6 个写函数开头 `if(!isAdmin.value) return` | 防未来改模板漏掉某个 v-if 的回归 |

**关键决策：**
- **可见范围**（川哥拍板"看全部页面"）：把现有 `isAdmin` 的语义从"既管可见又管可写"**收窄为只管可写**；可见性（菜单 `v-if="isAdmin"`）对 guest 放开。
- **持久登录 role 必须服务端校正**：前端从 localStorage 乐观恢复后立刻打 `/api/auth/check` 拿服务端真实 role 覆盖——**防 guest 篡改 localStorage 把自己提权成 admin**（前端 role 仅 UX，后端 403 才是真防线）。
- **guest 凭据走 env 带默认值**：`STUDIO_GUEST_USER ?? 'guest'` / `STUDIO_GUEST_PASS ?? '123456'` — 生产**零配置即生效**，想改配 env、置空字符串可禁用 guest；它是**公开只读门票不是 secret**，但 admin 真密码 `STUDIO_PASS` 仍只走 env 不写死。

## 四、实施

**后端（3 文件）：**
- `routes/auth.ts`（重写）：新增 guest 账号 + `tokenRoles` Map + 导出 `getTokenRole`；`/login` 先判 admin 再判 guest，返回 `{ok, token, role, username}`；`/check` 返回 `{ok, role, username}`；admin 未配 + guest 也禁用才 503。
- `routes/admin-data.ts` + `routes/feedback.ts`：`use('*')` 中间件加只读门控（非 GET 且 role≠admin → 403）。`conversation.ts` 全 GET，不改（guest 可读）。

**前端（`public/admin/index.html`）：**
- 登录 `handleLogin` 用 `data.role` 设 role（不再写死 admin）；持久登录 `onMounted` 改为乐观恢复 + `/check` 校正；`saveAuth`/`clearAuth` 存/清 role。
- 可见性：去掉 mock 菜单 + KidsHub 入口的 `v-if="isAdmin"`（登录即可见）；头部角色标签改「管理员」/「游客 · 只读」。
- 6 个编辑入口加 `v-if="isAdmin"` / `:disabled`（反馈抽屉用 `<template v-if="isAdmin">` 整体包裹 + guest 只读提示）；6 个写函数加 JS guard；登录页提示补 guest 说明。

## 五、验证（双门全过）

- **Gate1/2 本地**：`tsc --noEmit` 零错误；起本地 server（自给临时凭据）**真实 HTTP E2E 16/16**：admin/guest 登录 role 正确、guest 读 4 个 GET 全 200、guest 写 5 个接口全 403、admin 写通、错误密码/无 token/伪造 token 全 401。
- **生产 E2E**（`kidshub-ai.hahaxiong.cc`）：guest 登录 `role=guest` ✓ / 读 200×3 ✓ / 写 403×4 ✓ / 错误密码 401 ✓ / `/check` 返回 guest ✓ / admin 页新 guest 文案命中=新页部署成功 ✓。

## 六、部署与回滚

- **Step0 回滚点**：`/opt/p003/_backup/20260624-173608-guest-account/`（3 个 ts + admin 页原版）。
- **部署**：scp 4 文件到生产（字节核验本地=远程）→ `pm2 restart p003-voice`（个人站 `kidshub-voice` 不动）→ 生产 E2E 全绿。
- **一键回滚**：`ssh aliyun-hk 'BK=/opt/p003/_backup/20260624-173608-guest-account; cp $BK/server-routes/*.ts /opt/p003/server/src/routes/; cp $BK/web-admin/index.html /opt/p003/web/dist/admin/index.html; pm2 restart p003-voice'`
- 个人站按既定决策**冻结不动**（世界观 v1.0 同款决策）。

## 七、关键取舍 / 教训

- **前端隐藏 ≠ 权限**：后端 method 门控才是真防线；只做前端隐藏 = 假权限，curl 可绕。
- **method 门控比逐接口判断简洁**：中间件一处 `method!=='GET'` 覆盖该路由所有写。
- **持久登录必须 /check 校正 role**：否则 localStorage 可篡改提权（UI 层）。
- **guest 看 mock 演示假数据**：川哥明确选"看全部页面"的已知后果（可接受，那些页本就是占位）。

署名：cc（Claude）| 2026-06-24
