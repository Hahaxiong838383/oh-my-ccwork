---
name: p003-deploy-ops
description: P003 KidsHub 三端(家长端 parent / 体验台 web / admin 后台 / 后端 server)部署 + 邀请码运营管理 SOP（含血泪坑清单）。触发词："/p003-deploy"、"P003 部署"、"部署家长端/体验台/admin"、"P003 邀请码管理"、"加 P003 后台功能"、"P003 上线/发版"。涵盖:按改了哪端的部署步骤(server rsync+pm2 / admin scp from git / parent build base / web full build)、邀请码 CRUD/上限/昵称备注、admin DOM 内 Vue 坑、并行 session 防污染、生产 E2E 铁律。
---

# P003 三端部署 + 邀请码运营 SOP · V1

> 2026-06-16 沉淀。配套项目记忆 `project_p003_3end_integration`。场景美术化另见 `p003-scene-art`（主题不同）。
> 项目根:`/Users/rayman.chen/mycc/2-Projects/P003GameDemo20260513/`

## 架构 + 部署目标（用前 grep/ssh 核实,别凭记忆）

三端围绕后端 5 域(account / profile / device / conversation / feedback)按 `account_id` 隔离共享数据。

| 端 | 公网入口 | 生产路径 | 技术 |
|---|---|---|---|
| 家长端 parent | `p003.hahaxiong.cc/parent/` | `/opt/p003/parent/dist`(nginx alias) | 独立 vite,**base=/parent/** |
| 体验台 web | `kidshub-ai.hahaxiong.cc/`(+CF `kidshub.chenchuan.cc`) | `/opt/p003/web/dist` | vite SPA,main.tsx 按 hostname `kidshub*`/path `/kidshub-ai` 分流 |
| admin 后台 | `kidshub-ai.hahaxiong.cc/admin/` | `/opt/p003/web/dist/admin/index.html` | **单 HTML + DOM 内 Vue3 CDN + ElementPlus**,静态子站 |
| 后端 server | (内网 3001) | `/opt/p003/server` | pm2 `p003-voice`,tsx 直跑 src,`NODE_OPTIONS=--experimental-sqlite`,node:sqlite |

- 部署机 **aliyun-hk(8.218.26.17)**,同机还有 `chenchuan-site`/`kidshub-voice`,**别动**。
- server `.env.local`:`PORT=3001` / `STUDIO_USER` / `STUDIO_PASS`(admin 登录) / `AUTH_JWT_SECRET`(邀请码 JWT,生产 openssl 生成不外露) / `GEMINI_API_KEY`。
- 三独立 SQLite:`data/accounts.db`(账号+邀请码) / `profile.db`(family_member+device) / `conversation.db` / `feedback.db`。`data/` 被 gitignore,生产单独 seed。
- dev 端口差异:**parent vite proxy `/api`→8787**,**web vite proxy `/api`→3001**(本地验证起 server 要对应端口)。

## 部署 SOP（按改了哪端,只动相关的）

**Step 0 备份(必做,high blast)**:`ssh aliyun-hk 'ts=$(date +%Y%m%d-%H%M%S); bk=/opt/p003/_backup/$ts; mkdir -p $bk; cp -r 生产相关目录 $bk/'`

1. **server 改**(src/*.ts):`rsync -az apps/server/src/ aliyun-hk:/opt/p003/server/src/`(增量,不 --delete)→ `ssh aliyun-hk 'pm2 restart p003-voice'`(tsx 直跑,重启即加载新代码)。新增依赖先 `ssh ... 'cd /opt/p003/server && npm i <pkg>'`。新增 scripts/ 要一起 rsync(seed 脚本在 scripts 非 src)。
2. **admin 改**(public/admin/index.html):**`git show HEAD:<path>/admin/index.html > /tmp/admin.html` 导出正确版 → `scp /tmp/admin.html aliyun-hk:/opt/p003/web/dist/admin/index.html`**。绕工作区污染(见坑#4),不用 full build(admin 是静态 HTML)。
3. **parent 改**:`cd apps/parent && npm run build`(base=/parent/ 已固化进 vite.config)→ `rsync -az --delete dist/ aliyun-hk:/opt/p003/parent/dist/`(--delete 清旧 hash chunk)。
4. **web 改**(体验台/分流/admin 随 build):`cd apps/web && npm run build` → `rsync -az --delete dist/ aliyun-hk:/opt/p003/web/dist/`(--delete 清旧 chunk+SW;含 admin/,**注意会覆盖 admin/index.html=用工作区版本**,若工作区被污染先恢复)。

## 邀请码运营（三端身份锚点）

- **邀请码 `KH-XXXX` = accountId 锚点**,家长端/体验台/admin 三端登录同一码进同一账号。
- API(admin token Bearer,`admin-data.ts`):`GET /api/admin/invites`(列表+count+limit) / `POST /invites`(生成) / `DELETE /invites/:code`(删+级联) / `PATCH /invites/:code`(改家长昵称备注)。
- **上限 15 后端硬校验**(`account-store.countCodes()>=15` throw→400,前端 :disabled 只是 UX)。
- 生成:`KH-`+4 位(字符集排除易混 `0 O I L 1`)+`acct-NN` 递增+默认昵称`测试家长NN`,事务写 account+invite_code。
- 删除:级联清该 account 的 `family_member`+`device`(profileStore.deleteByAccountId),`conversation` 留审计。
- **家长昵称可编辑**=备注邀请码发给谁(admin el-input @change → PATCH → updateNickname)。
- 10 个 seed 码:`scripts/seed-accounts.ts`(KH-9K2M/4R7T/8W3X/2P6L/5N1V/7B9D/3H4F/6Q8S/1Z5C/0J7G)。

## 坑清单（都踩过,改前必看）

1. **admin DOM 内 Vue 自闭合**:`<el-table-column .../>`/`<el-input .../>` 自闭合→浏览器解析成嵌套**吞掉后续列**布局错乱,**必须成对** `<el-table-column ...></el-table-column>`。`el-tag` 在该 admin CSS 环境**不可见**→用 `<span :style="{color:...}">` inline color。
2. **parent base 子路径**:base 必须 `base:'/parent/'` 写进 `vite.config.ts`(别靠命令行 `--base`,换 `npm run build` 就丢)。丢了→HTML 引用 `/assets/*` 被 nginx 根 location SPA fallback 返 index.html(HTML 非 JS)**白屏**。验:`curl <子路径>/assets/<bundle>.js | head -c 40` 看是 JS 还是 `<!doctype`(只看 HTTP 200 会被 fallback 骗)。
3. **web PWA SW 子路径劫持**:web SW(VitePWA scope `/`)的 `navigateFallbackDenylist`+`globIgnores` 必须含每个同域新子路径(`/admin` `/parent`),否则子路径导航被 SW fallback 到 web 自己的 index.html(浏览器显错页,但 curl 是对的=纯客户端 SW 劫持)。改后 full build 重部署 SW,旧 SW 需无痕窗口/Unregister 才见新效果。
4. **并行 session 污染**(★ 川哥多 OMC session):工作区文件随时被并行 session 改,**commit 之后也不例外**(替换 gemini API 时误操作碰到 admin 的真实事故)。team/部署关键改动 **commit 后到 build/部署前再 `grep`+`wc -l` 验文件没被改回**;部署关键文件用 `git show HEAD` 导出快照部署绕污染工作区;可疑并行 session(`ps aux|grep claude`)报川哥别擅自 kill。
5. **nginx `$uri` 转义**:python 三引号写 nginx 配置时 `"""\$uri"""` SyntaxWarning 保留字面 `\$uri`→try_files 全 fallback(JS 请求返 HTML)→`.replace("\\$uri","$uri")` 修。
6. **preview 后台节流**:走长 UI 流程的 `preview_eval` 累加超 30s 反复超时→关键验证改 `curl` 直查后端 + 页面上下文 `fetch` 直走 proxy。preview_click 对 React/Vue onClick 不可靠→用 `eval` 找元素 `.click()`。preview viewport 默认可能 1px→显式 resize width/height。
7. **生产 server 可能落后**:部署前确认生产 routes/依赖齐(jose 等缺则 `npm i`)+ scripts/(seed 脚本)+ `.env`(AUTH_JWT_SECRET 生产 `openssl rand -hex 32` 生成不外露)。

## 验证铁律（cc 自己验,绝不甩给川哥）

- **后端改**:本地起 server(parent 任务用 8787 / web·admin 任务用 3001)→ `curl` 真实 API E2E(login→操作→验证→**恢复不污染本地 db**)。
- **前端改**:`preview` 截图 + 关键交互 `eval` 实测(如 el-input change→看 db 落库全链路)。
- **部署后生产 E2E**:`curl` 三端 200 + 关键 API + **`shasum` 本地 dist=生产**(或 vite content-hash 文件名比对)+ `grep` 新功能字符串实锤代码上线。
- **zsh 坑**:大 JS 存变量报 `character not in range`→`curl` 直接管道 grep/shasum 不经变量;`for x in $VAR` 不分词(zsh)→显式列表或 `${(s: :)VAR}`。

## 凭证/链接（指针,secret 绝不入 skill）

- 三端链接见上表。admin 登录 `admin / ⟨STUDIO_PASS 见生产 /opt/p003/server/.env.local⟩`。
- ⚠️ admin 口令历史散落多处记忆+git 历史,根治待轮换 STUDIO_PASS(见 task-log)。
