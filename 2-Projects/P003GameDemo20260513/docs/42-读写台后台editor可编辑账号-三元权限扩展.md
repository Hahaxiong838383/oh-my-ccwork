# 42 · 读写台数据后台 editor 可编辑账号 —— 二元→三元权限扩展

> 川哥 2026-07-01：给读写台数据 web 后台加 5 个可编辑账号 `clw1`-`clw5`（密码统一 `123456`），除「KidsHub 运营台 · 邀请码管理」页外，其他权限与 admin 一致。
> 本文承接 [41 · guest 只读三层门控](./41-kidshub运营台guest只读游客账号-三层权限门控.md)，把二元角色（admin/guest）扩成三元（admin/editor/guest）。已部署生产 `kidshub-ai.hahaxiong.cc/admin`，commit `a451ef3f5`。

## 一、需求与定位

- 5 个新账号 = 「admin 减一项能力」：能读能写全部真实数据（孩子档案 / 反馈 Issue / 产品开发看板 / 主题词表 / 对话历史 / reset-quota …），**唯独看不到也进不去「邀请码管理」页**（连查看都不行）。
- 账号：`clw1`-`clw5`，口令统一 `123456`（走 env，非 secret，与 guest 门票同级；admin 真口令 `STUDIO_PASS` 仍只走 env）。

## 二、方案：三元 RBAC（复用 doc41 三层门控骨架）

新角色 `editor`。核心决策 = **拓宽既有 `isAdmin` 语义 + 单加一个专属门**，改面最小：

| 维度 | 机制 |
|---|---|
| **账号来源** | env `STUDIO_EDITOR_USERS=clw1,clw2,clw3,clw4,clw5`（逗号分隔）+ `STUDIO_EDITOR_PASS=123456`。未配置则无此类账号。凭据不入 git，增删账号只改 env 不改码 |
| **后端·可写门控（真防线）** | 新 helper `canWrite(token)`=admin\|\|editor。`feedback`/`dev-items`/`themes`/`admin-data` 四路由中间件的非 GET 门由「仅 admin」放宽为 `!canWrite` → 403 |
| **后端·邀请码专属门控（真防线）** | 新 helper `isAdminRole(token)`=仅 admin。`admin-data` 中间件加：`路径含 /invites 且非 admin → 403`（**连 GET 都挡**，落实"不能查看"）。因 invites 与 profiles/reset-quota 混在同一路由，必须按 **path** 单独门，不能只靠 method |
| **前端·可见/可编辑（UX）** | `isAdmin` 计算属性语义拓宽为 `role==='admin'\|\|role==='editor'`（= "可编辑/特权视图"）→ 既有 ~30 处 `v-if="isAdmin"` 菜单与编辑入口对 editor 一次性放开（editor 视图 = admin） |
| **前端·邀请码专属隐藏（UX）** | 新 `canManageInvites`=`role==='admin'`。三层挡：`visibleKhNavs` 过滤掉 invites tab + view `v-if` 加 `&& canManageInvites` + `loadInvites()` 开头守卫 |
| **角色标签** | 三态：管理员（danger）/ 编辑员（warning）/ 游客·只读（info） |

## 三、★ 顺带修复的回归（重要）

doc41 曾让 admin 前端「登录用后端 `data.role` + `onMounted` 打 `/api/auth/check` 校正 role」实现 guest 只读。但**后续主题词表可编辑改动（commit c4c4ca4/7c66633/096b0a8）把登录流回退成硬编码 `currentUser.role='admin'`** —— repo 源、localize 产物、**连生产** admin 页三处 `data.role`/`/check` 全丢。后端 403 仍在（guest 安全没破），但前端退化成「谁登录都是 admin 视图」。

本次加 editor 必须让前端真读 role，于是**一并修回**：登录用 `data.role`、`saveAuth`/`clearAuth` 存/清 `kidshub_admin_role`、`onMounted` 乐观恢复 + `/check` 校正（防 localStorage 篡改提权）。

> 教训：靠「前端读后端 role」实现的权限 UX 会被后续无关改动静默硬编码掉；改任何 role 驱动的 UI 前先 grep 确认它还在真读 role。见 canonical 记忆 `rbac_editor_tier_and_frontend_role_regression`。

## 四、实施（7 文件）

**后端 5：** `routes/auth.ts`（+editor 账号解析 +`canWrite`/`isAdminRole`）、`admin-data.ts`（invites path 挡 + canWrite）、`feedback.ts`/`dev-items.ts`/`themes.ts`（getTokenRole!=='admin' → !canWrite）。
**前端 2：** `admin-proto/index.source.html`（源，改后重跑 `scripts/localize-admin-proto.mjs --force`）→ `public/admin/index.html`（产物）。

## 五、验证（双门全过）

- **本地**：server `tsc --noEmit` 0 err；临时 server 21/21 curl 权限矩阵；preview 真实登录 editor/admin 对照（editor 见 12 tab 无邀请码 / admin 见 13 tab）。
- **生产**（`kidshub-ai.hahaxiong.cc`）：15/15——clw1/clw4 登录=editor、非邀请码读 200、邀请码四端点全 403、guest 回归只读、admin 邀请码仍 200、editor reset-quota 写 200、/check 返回真实 role；公网 /admin/ 页 `shasum`==本地 HEAD。

## 六、部署与回滚

- **回滚点**：`/opt/p003/_backup/20260701-165425-editor-accounts/`（5 routes + admin 页 + .env.local）。
- **部署**：生产 `.env.local` 追加 editor env → `rsync src` + `pm2 restart p003-voice`（DeepSeek，ASR/LLM/TTS ready）→ admin 页 `git show HEAD → scp`（shasum 校验）。个人站 `kidshub-voice` **冻结不动**（无 account 模块，同 doc41 决策）。
- **一键回滚**：`ssh aliyun-hk 'BK=/opt/p003/_backup/20260701-165425-editor-accounts; cp $BK/server-routes/*.ts /opt/p003/server/src/routes/; cp $BK/web-admin/index.html /opt/p003/web/dist/admin/index.html; pm2 restart p003-voice'`（env 里的 STUDIO_EDITOR 可留，无害）。

## 七、已知取舍

- 「重置今日限额」按钮物理上在邀请码页内 → editor 隐藏该页时**连带看不到此按钮**（按川哥"隐藏邀请码页"字面执行，未擅自把按钮迁走）。后端 reset-quota 对 editor 仍开放（非 invites 路径），如需 editor 用可后续把按钮移出邀请码页。

署名：cc（Claude）| 2026-07-01
