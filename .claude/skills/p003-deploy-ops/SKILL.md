---
name: p003-deploy-ops
description: P003 KidsHub 三端(家长端 parent / 体验台 web / admin 后台 / 后端 server)部署 + 邀请码运营管理 SOP（含血泪坑清单）。触发词："/p003-deploy"、"P003 部署"、"部署家长端/体验台/admin"、"P003 邀请码管理"、"加 P003 后台功能"、"P003 上线/发版"。涵盖:按改了哪端的部署步骤(server rsync+pm2 / admin scp from git / parent build base / web full build)、**两端 server 部署(公司侧 p003-voice·gemini 全量版 + 个人站 kidshub-voice·DeepSeek 精简版,不同源·同步要适配)**、邀请码 CRUD/上限/昵称备注、admin DOM 内 Vue 坑、并行 session 防污染、生产 E2E 铁律。
---

# P003 三端部署 + 邀请码运营 SOP · V1

> 2026-06-16 沉淀。配套项目记忆 `project_p003_3end_integration`。场景美术化另见 `p003-scene-art`（主题不同）。
> 项目根:`/Users/rayman.chen/mycc/2-Projects/P003GameDemo20260513/`

## 架构 + 部署目标（用前 grep/ssh 核实,别凭记忆）

三端围绕后端 5 域(account / profile / device / conversation / feedback)按 `account_id` 隔离共享数据。

| 端 | 公网入口 | 生产路径 | 技术 |
|---|---|---|---|
| 家长端 parent | `p003.hahaxiong.cc/`(**根路径,2026-08-23 起**;旧 /parent/* 301 兼容 fragment 保留) | `/opt/p003/parent/dist`(nginx root) | 独立 vite,**base='/'**;⚠️ **dist 是多写者面(codex 也直推)** |
| 体验台 web | `kidshub-ai.hahaxiong.cc/`(+CF `kidshub.chenchuan.cc`) | `/opt/p003/web/dist` | vite SPA,main.tsx 按 hostname `kidshub*`/path `/kidshub-ai` 分流 |
| admin 后台 | `kidshub-ai.hahaxiong.cc/admin/` | `/opt/p003/web/dist/admin/index.html` | **单 HTML + DOM 内 Vue3 CDN + ElementPlus**,静态子站 |
| 后端 server(公司侧) | (内网 3001) | `/opt/p003/server` | pm2 `p003-voice`,tsx 直跑 src,`NODE_OPTIONS=--experimental-sqlite`,node:sqlite,**gemini**,全量 13 文件 |
| **个人站 server** | `my.chenchuan.cc/kidshub-ai`(WS `/ws/voice`→3002) | `/opt/kidshub-personal/server` | pm2 `kidshub-voice`,**DeepSeek**,**2026-06-13 迁移的早期精简版 5 文件(无 orchestrator/curriculum/account)** |

- 部署机 **aliyun-hk(8.218.26.17)**,同机还有 `chenchuan-site`(别动);**`kidshub-voice`=个人站 server(见上表,独立部署目标,与公司侧不同源,功能同步要适配见 Step 1b)**。
- server `.env.local`:`PORT=3001` / `STUDIO_USER` / `STUDIO_PASS`(admin 登录) / `AUTH_JWT_SECRET`(邀请码 JWT,生产 openssl 生成不外露) / `GEMINI_API_KEY`。
- 三独立 SQLite:`data/accounts.db`(账号+邀请码) / `profile.db`(family_member+device) / `conversation.db` / `feedback.db`。`data/` 被 gitignore,生产单独 seed。
- dev 端口差异:**parent vite proxy `/api`→8787**,**web vite proxy `/api`→3001**(本地验证起 server 要对应端口)。

- **L_companion 陪伴域知识层（2026-07-13 上线）**：`src/companion-kg.ts` + `assets/companion-kg/`（os-taxonomy 中文切片 376 主题 + bge 向量表 3.5M，许可署名见其 SOURCE.md）。env 依赖：`COMPANION_KG=1`（灰度开关，默认关=零行为）+ `SILICONFLOW_API_KEY`（query 向量，bge-large-zh-v1.5）+ `COMPANION_SIM_THRESHOLD`（默认 0.47）。互斥链 K12>AI 启蒙>companion。**改 embedding 模型必须重算向量表**（query/passage 同模型铁律）。观测日志 `[companion-kg] hit【主题】分数 / skip(no-vector|low-score)`（不落孩子原话）。回滚三级见 `apps/server/DEPLOY-LOG-companion-kg.md`。

## 部署 SOP（按改了哪端,只动相关的）

**Step 0 备份(必做,high blast)**:`ssh aliyun-hk 'ts=$(date +%Y%m%d-%H%M%S); bk=/opt/p003/_backup/$ts; mkdir -p $bk; cp -r 生产相关目录 $bk/'`

1. **server 改**(src/*.ts):`rsync -az apps/server/src/ aliyun-hk:/opt/p003/server/src/`(增量,不 --delete)→ `ssh aliyun-hk 'pm2 restart p003-voice'`(tsx 直跑,重启即加载新代码)。新增依赖先 `ssh ... 'cd /opt/p003/server && npm i <pkg>'`。新增 scripts/ 要一起 rsync(seed 脚本在 scripts 非 src)。验证 LLM ready 看 `pm2 logs p003-voice | grep LLM:`。
1b. **个人站 server 同步**(功能要两端时,如 AI 启蒙):个人站 `/opt/kidshub-personal` 是早期精简版(5 文件 / DeepSeek / 无 orchestrator·curriculum·account)→**不同源,绝不能盲 rsync 公司侧 13 文件**(会塞它没有的依赖崩)。做法:① `ssh aliyun-hk` diff 比对 src 同源程度(`grep -c` 关键标志) ② 新文件(纯函数无依赖)直接 `scp` ③ 改 pipeline 等共享文件**手动适配个人站简化版**(`scp` 下来本地 Edit 改回,绕生产直改)+ `_backup/` 备份 ④ `pm2 restart kidshub-voice` + 公网 E2E(`wss://my.chenchuan.cc/ws/voice`)。
2. **admin 改**(public/admin/index.html):**`git show HEAD:<path>/admin/index.html > /tmp/admin.html` 导出正确版 → `scp /tmp/admin.html aliyun-hk:/opt/p003/web/dist/admin/index.html`**。绕工作区污染(见坑#4),不用 full build(admin 是静态 HTML)。
3. **parent 改**(⚠️ 规矩 2026-08-23 改,事故见坑#10):`cd apps/parent && npx vite build`(base='/' 已固化)→ 部署三步走:
   ① **指纹核对**:`ssh aliyun-hk 'ls /opt/p003/parent/dist/assets/'` 看线上 bundle 是不是**我上次部署的**——出现陌生 hash=有别人(codex)写过,**停手先问川哥**;
   ② **服务器侧备份**:`ssh aliyun-hk 'cp -r /opt/p003/parent/dist /root/p003-dist-bak-$(date +%Y%m%d-%H%M%S)'`;
   ③ `rsync -az dist/ aliyun-hk:/opt/p003/parent/dist/`——**永久禁 --delete**(它把「本地没有的文件」全删,验证面只覆盖自己改的文件,删除面是全目录;真要清旧 chunk 先 `rsync -azn --delete` dry-run 看 deleting 列表,全部确认是自己的旧产物才加 --delete 跑一次)。
   自杀式 `public/sw.js` 永久保留(SW 清场,勿删)。
4. **web 改**(体验台/分流/admin 随 build):`cd apps/web && npm run build` → `rsync -az --delete dist/ aliyun-hk:/opt/p003/web/dist/`(--delete 清旧 chunk+SW;含 admin/,**注意会覆盖 admin/index.html=用工作区版本**,若工作区被污染先恢复)。

## S2B1 设备 Session API（2026-08-15 上线,安卓/MCU 设备换 LiveKit token）

- **端点**:`POST /v1/device/session` + `/session/prefetch`(Base=kidshub-ai.hahaxiong.cc;nginx `/v1/` 反代本就存在零改动)。
- **文件**:`src/device-sn.ts`(SN 纯函数)/`src/routes/device-session.ts`/`scripts/device-session.test.ts`(16 项,`npx tsx` 直跑)/`scripts/sign-device-credential.ts`。
- **env 键**(.env.local 尾部):`LIVEKIT_API_KEY=voicekey`/`LIVEKIT_API_SECRET`(源=47.239 /etc/livekit/config.yaml,管道直传别落盘)/`LIVEKIT_URL`/`DEVICE_SN_ALLOW`(白名单 fail-closed,逗号分隔)/`DEVICE_SESSION_TTL_S=3600`/`DEVICE_SESSION_RPM=10`。
- **加新设备**:SN 追加进 `DEVICE_SN_ALLOW` → `pm2 restart p003-voice` → 服务器上签凭据:`set -a; . ./.env.local; set +a; npx tsx scripts/sign-device-credential.ts <SN> 30`(输出即凭据,管道接走禁回显/进 git)。
- **新设备接 brain(2026-08-20 起零配置)**:admin 台账加 SN → 点「开通 brain」即完成——身份由房名 SN 自动路由,**无 token 要配**(brain_token 分发已取消,commit af8d3cf0d;开通响应只回 account_id)。设备命令 canary 已全量(env 列表空=sn- 房全开),新设备开箱即用;**二遍 ASR 仍名单制**(火山账单口径观察中):`VOLC_ASR_NONSTREAM_CANARY_SN` 追加 SN 小写+64.90 纪律重启,不加=一遍链路(热词只 100 tokens)。
- **⏰ worker 通行证 2027-08-17 前后过期(定时炸弹)**:过期后 worker 调大脑**静默降级匿名——记忆全失不报错**。提前续:aliyun-hk `cd /opt/p003/server && set -a; . ./.env.local; set +a; npx tsx scripts/sign-worker-token.ts`(唯一签发口)→ 换 64.90 rust-worker.env 的 LLM_URL_QUERY → 纪律重启。role=device token 仅设备房有效(非 sn- 房匿名,probe 污染洞已堵)。
- **pm2 env 事实**:p003-voice 启动参数是 `tsx --env-file=.env.local` → **restart 即重读 env 文件**,老「pm2 env 快照」坑不适用此形态(快照坑只咬 `pm2 start` 时从 shell 继承 env 的进程)。
- **改动后必跑**:`npx tsx scripts/device-session.test.ts`(16/16)+ 灰度先行(`PORT=3005` 同 env 起 staging 打 E2E 再动生产——川哥 2026-08-15 门禁铁律)+ 公网 claims 校验(解 token 对 sub/room/agents/exp)。
- **回滚**:`/root/p003-server-src-bak-20260815-pre-device-session.tgz` + 删 .env.local 尾部 S2B1 段 7 行 → restart → `/v1/device/session` 应回 404。

## 邀请码运营（三端身份锚点）

- **邀请码 `KH-XXXX` = accountId 锚点**,家长端/体验台/admin 三端登录同一码进同一账号。
- API(admin token Bearer,`admin-data.ts`):`GET /api/admin/invites`(列表+count+limit) / `POST /invites`(生成) / `DELETE /invites/:code`(删+级联) / `PATCH /invites/:code`(改家长昵称备注)。
- **上限 15 后端硬校验**(`account-store.countCodes()>=15` throw→400,前端 :disabled 只是 UX)。
- 生成:`KH-`+4 位(字符集排除易混 `0 O I L 1`)+`acct-NN` 递增+默认昵称`测试家长NN`,事务写 account+invite_code。
- 删除:级联清该 account 的 `family_member`+`device`(profileStore.deleteByAccountId),`conversation` 留审计。
- **家长昵称可编辑**=备注邀请码发给谁(admin el-input @change → PATCH → updateNickname)。
- 10 个 seed 码:`scripts/seed-accounts.ts`(KH-9K2M/4R7T/8W3X/2P6L/5N1V/7B9D/3H4F/6Q8S/1Z5C/0J7G)。

## 限额运营（公网防刷兜底）

`guard.ts` per-IP 日限额(内存 Map,UTC+8 自然日重置,**进程重启即清**):`ws_session 连接 / chat_round 对话轮 / vision`,默认 `60/120/200`,env `GUARD_WS_SESSIONS_PER_DAY`/`GUARD_CHAT_ROUNDS_PER_DAY`/`GUARD_VISION_PER_DAY` 覆盖(0=不限)。`getClientIp` 优先 `x-real-ip`(nginx `/ws/voice` 必设 `X-Real-IP $remote_addr`)。
- **误伤排查**:报"今日体验次数已达上限"先看日志 `[ws] open ip=` 是否真实客户端 IP(非 127.0.0.1 共享限额)→排除 IP 取错→再判真超限。同文案两处:ws_session(连不上进不去)/chat_round(进去后语音报错),据此定位。
- **内测调大**:`.env.local` `GUARD_*=1000/2000` + `pm2 restart`;**正式开放前必改回 60/120/200**(公网无密码裸放被刷量/刷费)。
- **admin 自助重置**:邀请码页顶部「重置今日限额」按钮(`POST /api/admin/reset-quota` → `guard.resetAllQuotas()` 清 Map),内测自助免 ssh,不重启服务/不断连接。

## 坑清单（都踩过,改前必看）

1. **admin DOM 内 Vue 自闭合**:`<el-table-column .../>`/`<el-input .../>` 自闭合→浏览器解析成嵌套**吞掉后续列**布局错乱,**必须成对** `<el-table-column ...></el-table-column>`。`el-tag` 在该 admin CSS 环境**不可见**→用 `<span :style="{color:...}">` inline color。**第二变体(2026-08-18)**:in-DOM 模板属性名被 HTML 解析器小写化——`:viewBox` 动态绑定变 `:viewbox`,SVG 不认(图谱空白);camelCase SVG 属性**静态写**(浏览器 foreign-content 自动修正 case),值是常量就别用 v-bind。模板表达式里也不准写 `function(){}` 与多语句 `if`(用 $event/方法调用)。
2. **parent base**(2026-08-23 已升根路径 base='/'):base 必须写进 `vite.config.ts`(别靠命令行 `--base`,换 `npm run build` 就丢)。通用教训:base 与 nginx location 不匹配→assets 被 SPA fallback 返 index.html(HTML 非 JS)**白屏**。验:`curl <站点>/assets/<bundle>.js | head -c 40` 看是 JS 还是 `<!doctype`(只看 HTTP 200 会被 fallback 骗)。
3. **web PWA SW 子路径劫持**:web SW(VitePWA scope `/`)的 `navigateFallbackDenylist`+`globIgnores` 必须含每个同域新子路径(`/admin` `/parent`),否则子路径导航被 SW fallback 到 web 自己的 index.html(浏览器显错页,但 curl 是对的=纯客户端 SW 劫持)。改后 full build 重部署 SW,旧 SW 需无痕窗口/Unregister 才见新效果。
4. **并行 session 污染**(★ 川哥多 OMC session):工作区文件随时被并行 session 改,**commit 之后也不例外**(替换 gemini API 时误操作碰到 admin 的真实事故)。team/部署关键改动 **commit 后到 build/部署前再 `grep`+`wc -l` 验文件没被改回**;部署关键文件用 `git show HEAD` 导出快照部署绕污染工作区;可疑并行 session(`ps aux|grep claude`)报川哥别擅自 kill。
5. **nginx `$uri` 转义**:python 三引号写 nginx 配置时 `"""\$uri"""` SyntaxWarning 保留字面 `\$uri`→try_files 全 fallback(JS 请求返 HTML)→`.replace("\\$uri","$uri")` 修。
6. **preview 后台节流**:走长 UI 流程的 `preview_eval` 累加超 30s 反复超时→关键验证改 `curl` 直查后端 + 页面上下文 `fetch` 直走 proxy。preview_click 对 React/Vue onClick 不可靠→用 `eval` 找元素 `.click()`。preview viewport 默认可能 1px→显式 resize width/height。
7. **生产 server 可能落后**:部署前确认生产 routes/依赖齐(jose 等缺则 `npm i`)+ scripts/(seed 脚本)+ `.env`(AUTH_JWT_SECRET 生产 `openssl rand -hex 32` 生成不外露)。
8. **个人站 vs 公司侧不同源**(2026-06-19 AI 启蒙踩):个人站 `/opt/kidshub-personal`(kidshub-voice:3002,DeepSeek,精简 5 文件) ≠ 公司侧 `/opt/p003`(p003-voice:3001,gemini,13 文件)。两端功能同步**先 ssh diff 判同源再动**(新文件 scp / 共享文件手动适配),盲 rsync 必崩。
9. **本地起 server 验证踩坑**(2026-06-19):① `.env.local` 的 `GEMINI_API_KEY` 可能空(本地不调 gemini,生产走 Keychain gemini-proxy-token)→起 server 前 `export GEMINI_API_KEY=$(security find-generic-password -s gemini-proxy-token -a gemini-proxy -w)` 覆盖,否则启动日志 `LLM: missing-env` ② WS 路径必须 `/ws/voice`(index.ts upgrade pathname 校验,否则 socket hang up) ③ 不走语音的文字对话 E2E 入口=`chat.trigger`(type+text),收 `debug.prompt_assembled` 验 prompt 真注入。
10. **kidshub-ai vhost 里的 `/myjavis/` location 是 MyJavis 项目的火山回调中转**(2026-07-02 加,非 P003 业务):反代 → `javis.chenchuan.cc`(47.239.204.68 手机号账号 HK ECS)。存在原因=字节机房出境仅本机(8.218 国际站段)可达,MyJavis 自己的 47.239(中国站段)火山直连零到达。**改 kidshub-ai vhost 时别删它**;它只承载火山→MyJavis 的回调流量,与 P003 的 `/v1/` 互不影响。详见 memory `feedback_volc_customllm_callback_geo_constraint`。

11. **跨域名 SPA 兜底假 200**(2026-08-20 sms-auth 部署踩):`kidshub-ai.hahaxiong.cc/parent/` 并无此路径,但 web 根 location `try_files /index.html` 兜底返回 **200+体验台 shell(7月旧 hash)**——rsync 明明成功、hash 却对不上,真因是**域名打错了**(家长端在 `p003.hahaxiong.cc/parent/`,见架构表)。部署验证 hash 不一致时:**先对架构表核对入口域名,再疑缓存**;SPA catch-all 会把 404 伪装成 200,`last-modified` 是旧日期即强信号。

12. **pm2 重启存活是部署验收项非可选**(2026-07-13 实锤):服务器 07-12 重启后 pm2 三服务全灭一天多(无 startup),chenchuan-site/p003-voice/kidshub-voice 全下线无告警。已配 `pm2 startup systemd + pm2 save`(systemctl is-enabled pm2-root=enabled)。**新增/删除 pm2 进程后必须重跑 `pm2 save`**,否则下次重启回到旧 dump。机器内存仅 1.6G/无 swap——上新功能先 `free -h` 侦察,进程内大模型必死,重资产走离线预计算(见 memory low-ram-vps-ai-offline-precompute)。

10. **parent dist 多写者覆盖事故**(2026-08-23,详见记忆 feedback_operation_scope_exceeds_verified_scope):codex 当天 11:30 直推过他的联调构建(带 workbox PWA),cc 按旧 SOP `rsync --delete` 部署把它整套删了(服务器零残骸不可恢复,只能 codex 重出)。**同源核对只覆盖自己改的文件,挡不住 --delete 的全目录删除面**;deleting 输出被 `tail`/`-q` 吞=破坏无痕。取证法:**nginx `p003-access.log` 是被删静态资产的尸检报告**——bundle hash 文件名的首次/末次出现+状态码(200→304→消失)钉死第三方构建的上线与死亡时刻(`grep "index-XXX" /var/log/nginx/p003-access.log`)。另:codex 构建若再带 PWA/workbox=SW 劫持事故(坑#3 同 origin 第三次)前兆,发现即挑明。

11. **「部署成功但客户端停旧版」排查树**(2026-08-23,薄壳退出登录无反应轮):三种机制症状同形——①旧 PWA SW 离线回放(坑#3,grep registerSW/workbox) ②**index.html 无 Cache-Control=启发式缓存**(基于 Last-Modified 的 10%,WebView 可长期用旧 html;且 dist 部署禁 --delete 后旧 bundle 仍在,旧 html 完全可用=**零报错地停旧版**) ③客户端内嵌 dist(APK 打包,必须重发版)。已治本②:p003 nginx SPA 缓存策略——`/`、`/index.html`、`/sw.js` 一律 `no-cache`,hashed js/css `30d+immutable`(备份 /root/p003.nginx.bak-cache-headers-20260823);**新站配 nginx 时入口 html 必配 no-cache**,否则每次部署都欠一批存量客户端的强刷。验证:`curl -sI <站点>/ | grep -i cache-control`。

## 遥测运维（2026-08-25 上线,合同详情见记忆 p003_telemetry）

- 库:`/opt/p003/server/data/telemetry.db` 三表(snapshot/event/daily);日志锚 `[telemetry] batch`(含 skew)。**设备通道走 kidshub-ai 域名的 nginx block(/v1/ 反代),p003 站日志查不到遥测请求是正常的**。
- env 开关(改后 pm2 restart):`TELEMETRY_SN_ALLOWLIST`(未设=放开;Canary=仅0010)/`TELEMETRY_ACCEPTANCE_OVERRIDE`(401|403|409|429|500 注入,**测完必删键+restart**,防 debug 残留)/`TELEMETRY_INJECT_RETRY_AFTER`(注入 429 头值,默认 60 同真实限流,补验区分用 45)。
- **限频 240 次/h/SN**(2026-08-25 提额:设备 30s 节奏=120/h,原 60 不到一半——恢复后 30 分钟打满全 429,症状与「注入没恢复」同形,靠头值 60vs45 区分;定容量参数先把消费方节奏求和)。
- 验 allowlist 门用**空批探针**(零数据污染):目标 SN 凭据+空批→400 empty_batch=过门;白名单外→403 device_not_allowed。门序=注入→凭据→allowlist→限频→schema,400 即证明过了前面所有门。
- **多轮注入用服务器排程脚本**(sleep_until+switch,参考 /root/telemetry-inject-v105.sh,日志 /root/telemetry-inject-schedule.log)——逐轮人肉传话改一张时间表;ssh 起远端 nohup 会挂住本地(setsid 不救):**本地挂≠远端失败,读任务输出文件确认远端态再 TaskStop**;杀排程用具体 pid 或 `ps aux | grep "[t]el-"` 方括号技法,pkill -f 会自匹配杀掉自己的 ssh。
- 测试:`npm run test:telemetry`(29 项);家长查询走 public_id 非 SN(bound-devices 带此字段)。

## 验证铁律（cc 自己验,绝不甩给川哥）

- **后端改**:本地起 server(parent 任务用 8787 / web·admin 任务用 3001)→ `curl` 真实 API E2E(login→操作→验证→**恢复不污染本地 db**)。
- **前端改**:`preview` 截图 + 关键交互 `eval` 实测(如 el-input change→看 db 落库全链路)。
- **部署后生产 E2E**:`curl` 三端 200 + 关键 API + **`shasum` 本地 dist=生产**(或 vite content-hash 文件名比对)+ `grep` 新功能字符串实锤代码上线。
- **zsh 坑**:大 JS 存变量报 `character not in range`→`curl` 直接管道 grep/shasum 不经变量;`for x in $VAR` 不分词(zsh)→显式列表或 `${(s: :)VAR}`。

## 阿里云短信认证（用户注册/登录,2026-08-20 开通+P0 上线川哥验收 OK）

- 真值全档见记忆 `rg 'sms|短信|dypnsapi' ~/.claude/.../memory/`（project_p003_sms_auth.md）。速查:
  **账号 cc-remote**(⚠️非 hk-personal)/签名 `恒创联众`(6 赠送之一)/模板 **100001**(登录注册)/
  TemplateParam `{"code":"##code##","min":"5"}`(托管核验,CheckSmsVerifyCode 直接校验零存码)。
- **生产接口**:`/api/auth/sms/send`(三窗限流 data/sms.db 持久化)+`/sms/verify`(PASS→phone upsert
  acct-NN→JWT,与邀请码同姿势 bind-sn 直通)。**bind-sn 已升级绑定即接入大脑**(自动开 brain+建档)。
  env 键:`ALIYUN_SMS_ACCESS_KEY_ID/SECRET`(.env.local 尾部)。测试:`npm run test:sms`(36 项)。
- CLI 实测: `aliyun dypnsapi send-sms-verify-code -p cc-remote --phone-number <号> --sign-name '恒创联众' --template-code 100001 --template-param '{"code":"##code##","min":"5"}' --code-length 6` → `check-sms-verify-code --phone-number <号> --verify-code <码>`。
- **E2E 顶码桥**(免读短信):server send 后 CLI 同号加 `--interval 1 --return-verify-code true` 重发
  顶掉旧码拿新码→server verify 即 PASS。⚠️ 只绕 60s 窗;同号一天 6+ 条触发 `biz.FREQUENCY` 小时窗
  CLI 也取不了——测试省着发。
- 红线:**生产禁 `--return-verify-code true`**(仅调试);AK env 注入;发码接口业务限流(号码三窗+IP),阿里云 60s 频控只是兜底。

## Android OTA（2026-08-21 P0 全链验收闭环,正式可用）

- 全档见记忆 `rg 'ota|OTA' ~/.claude/.../memory/`（project_p003_ota.md,含合同冻结值/验收五步）。
- **发布 SOP**:admin后台→Worker 管理→OTA 升级 tab:上传 APK(服务端 aapt/apksigner **实测校验**:
  包名 com.futurus.p003.launcher/冻结证书/versionCode 单调,APK 本体为真值)→灰度发布(输 SN 名单)或
  全量发布(显式确认)→观察「设备版本分布」表(设备 check 自动上报)。**暂停只救未升级设备**(APK 层无真回滚)。
- 部署真值:APK 落 `/opt/p003/ota/`;**`.env.local` 必配 `OTA_DIR=/opt/p003/ota`**(2026-08-21 踩:漏配则
  server 默认落 data/ota 与 nginx alias 劈叉,上传全绿但下载 404——check 可见≠可下载,发布后必打一发
  Range 探针验 206+PK 头);ota.db 在 data/;nginx `/ota/` limit_rate 1m+双 limit_conn 闸
  (语音带宽优先,下载慢=预期);上传走 `location = /api/admin/ota/upload`(300m+流式);aapt/apksigner 已 apt 装。
- check 接口:`POST /v1/device/ota/check`(S2B1 设备凭据;测试:服务器 sign-device-credential.ts 签凭据 curl)。
- 测试:`npm run test:ota`(30 项)。⚠️ 川哥非代码任务:JKS 签名 key 异地加密备份(只在 Studio 构建机)。

## 配网即绑定 v2（2026-08-22 server/H5 上线,真机 Canary 待 codex SoftAP POC）

- **架构**:SoftAP 两阶段(热点码填 WiFi→URL 绑定码扫进 H5)+nonce 桥+ECIES 加密交付;全景真值锚
  `rg p003_pairing` canonical 记忆。**WiFi 密码不经 H5 不经 server**。
- **接口**:`POST /api/parent/pairing/confirm`(家长JWT,sn+nonce+pk 三元组固定,pk 真实曲线点校验)/
  `POST /v1/device/pairing/claim`(pairing_protocol=2,状态码 404 pairing_pending·409 nonce_used·
  410 nonce_expired)/`GET status?session_id=`。v1(bind_token)开关 `PAIRING_PROTOCOL_V1_ENABLED`
  默认关,回滚=置 1+restart。
- **部署**:server 照常 rsync+pm2;parent H5=`npm run build`+rsync --delete(深链页 PairBindPage,
  生产验证=hash 对撞+`grep pairing/confirm` 产物实锤);**2026-08-23 起家长端在 p003.hahaxiong.cc 根路径**(vite base='/',
  nginx root 指 parent/dist,旧 /parent/* 301 且 fragment 保留,体验台走 kidshub-ai 域名)。
  ⚠️ **前任体验台是 PWA:自杀式 sw.js 在 parent/public/ 永久保留勿删**(删了用户浏览器里的旧 SW 复活,重新离线回放体验台;404 杀不死 SW 是规范行为);用户报「打开还是旧站」先问 SW 再查缓存。库 pairing.db 两表(v1 token/v2 session,additive)。
- **密码学坑位**:salt=SHA256(nonce **传输形态字符串** UTF-8,不是解码 bytes);
  `credential_expires_at_ms` 必须===JWT exp*1000(先取整秒再派生,毫秒尾数差=端上双校验拒);
  跨语言对撞用 `scripts/fixtures/pairing-ecies-vectors.json`(生成器可重跑自检)。
- **测试**:`npm run test:pairing`(49 项);验收期解绑 0010 第一轮只清 parent_account_id
  (数据零丢失,brain id 确定性重挂);测试家长账号点对点给不入文档。

## 小可称呼/人设排查（2026-08-23 沉淀）

- 现象「改了称呼不生效/叫回旧称呼」四步：①**先全量搜历史对话**定位第一次改称呼时刻
  （`conversation` 表 rg `称呼|叫我|别叫`,全量非截断）——体验窗可能横跨抽取链路上线时刻(8-19)
  ②查画像终态 `family_member.nickname`(profile.db,称呼全走 nickname,preferred_address 恒空)
  ③查 `device_registry.worldview_override` 首句有没有写死称呼词(与画像「或」型并存=随机回落)
  ④生产对撞 `buildDeviceLayers` 的 final:判据=含「一律叫 ta「X」」指令行+无写死称呼残留。
- DB 文本替换引号形态是待验事实(弯vs直引号),先 JSON.stringify 看真实字节或用正则兜任意引号。

## 人格成长运维（2026-08-26 上线,机制详情见记忆 p003_persona_growth）

- **开关全集**(.env.local,共享 allowlist):`PERSONA_STATE_TRACK/INJECT` + `PERSONA_STYLE/INSIGHT/NARRATIVE/TRAIT_ENABLED`
  + `PERSONA_STATE_ACCOUNT_ALLOWLIST`(设备账号形态 `device-<SN>`,逗号分隔;**004=真孩子永不进名单**)。
  回滚=关对应键 restart,数据无损;账本只写不读主链,关了零影响。
- **一站式排障**:`GET /api/admin/devices/<SN>/persona-probe`(开关/关系/注入实况七段=真实 prompt 链抓取/
  风格池/画像/叙事/特质/账本数);CLI `python3 scripts/persona-probe.py <SN> probe|run`(run=手动跑
  M3 画像+M6 叙事立即出结果,不等每日沪时 3 点批);时间线 `GET .../growth-events?module=&dimension=&limit=`。
- **日志锚**:`pm2 logs p003-voice | grep -E "\[persona\]|\[trait\]|\[style\]|\[insight\]|\[narrative\]|\[ledger\]"`;
  [persona] recordTurn 的 applied/stale(乱序拒)/注入位图,[persona-daily] 定时批。
- **重置**:`DELETE .../relation-state` 清五样(relation/style/insight/trait/ledger);换绑不同家长自动全清;
  admin「🌱 人格成长」tab 有确认框按钮。
- **回填**:`scripts/backfill-relation-state.ts --account <id> [--apply]`(dry-run 默认;
  **直查 conversation.db SQL**——conversationStore.list 内部 clamp 1000 条,老账号 first_seen 会算晚)。
- **admin 单文件(in-DOM Vue)改动流程**:dist/admin/index.html 无构建直接改;验证=①标签配平 python 检查
  **对撞原始备份看差异**(基线自带 4 个 parser 假报,绝对数没意义)②部署后开登录页——**渲染成功=Vue
  运行时整树一次编译全模板通过**(新 subTab 模板语法错会全页白屏,不用登录即可验);el-input 必须显式闭合。
- 单测 `npm run test:persona`(115 项);测试选句先对照规则分支(7 字句会触发短句镜像——中性输入要验证过)。

## 本地人格音频运维（2026-08-26 D1 全绿,机制/联调详情见记忆 p003_local_audio）

- **是什么**:设备本地招呼语/结束语随人格成长换新。六语义 slot(greeting.normal/cover_open/presence_return +
  farewell.general/goodbye/night),每 slot 3-5 条;server 生成+讯飞合成→设备半夜(沪时 04-06)抓取轮换播放。
- **开关**:`PERSONA_LOCAL_AUDIO_ENABLED`(现=1 canary)+共享 persona allowlist(**004 永不进**)。
  回滚=键置 0 restart→全体 `{enabled:false}` 设备回落出厂音零残留;全回滚锚 `_backup/20260826-local-audio-d1/`。
- **讯飞凭据(11200 の坑)**:生效=appid 尾 **a69b** 健康套(剩 636 万字符/并发 100/至 2027-08,源=川哥 rtf 文档);
  **尾 ce7d=GameDemo 遗留、音色未授权→11200 LiccCheck,永远别换回去**;换前备份 `env.local.pre-xfyun-swap`。
  验活 `npm run probe:xfyun`(通=TTFB ~200ms 落盘 /tmp mp3)。
- **排障入口**:probe 端点含 `local_audio` 段(revision/各 slot 文案与时长/**last_applied_revision=设备触达证据**);
  手动生成 `POST /api/admin/devices/<SN>/persona-local-audio-run`(默认 force,~2min 六 slot 串行);
  时间线 `growth-events?module=local_audio`;日志锚 `grep "\[local-audio\]"`(gen slot 拒因计数/manifest/file)。
- **设备端点**:`GET /v1/device/local-audio/manifest?applied_revision=N` + `/file/:id`(设备凭据 sub 取 SN;
  公网入口**只有 kidshub-ai.hahaxiong.cc 反代 /v1/**)。`revision=0+slots 空=尚无内容非错误`。
- **SHA 投毒负测(J5)**:env `LOCAL_AUDIO_POISON_ID=<16hex>` → manifest 该条 sha 首字符翻转(文件不动);
  **测完删键+restart**(同 DEVICE_CONFIG_ACCEPTANCE_OVERRIDE 纪律)。
- **发布语义**:六 slot 各≥2 条才整套原子 commit(凑不齐现套与基准均不动,次日批自愈);新条目 staging(active=0)
  落库 commit 统一翻;同 slot 同文案复用旧音频不重合成。LLM 偶发 `[{"文案"}]` 伪 JSON 已有容错,
  再遇 slot 空手先看 `llm bad-json` 日志的 raw 样本再归因。
- 单测 `npm run test:local-audio`(61);E2E `scripts/local-audio-e2e.mjs off|on` + `scripts/la-admin-e2e.py <SN>`
  (**admin 登录要 username+password 双字段**,只发 password 恒 401)。
- **🔴 探针纪律(D2 起铁律)**:任何 cc 侧探针/curl **禁止带 `applied_revision` 参数**——`last_applied_*`
  是「Android 真机原子应用」的**独占证据位**,己方写入(含写 0)即污染 A3/J2 触达锚(D1 犯过,codex 抓的,已清零)。
- **源码审计锚**:server 无 git,每轮变更出只读 tar+SHA 落 `_backup/`(排除 .env——secret 不入档);
  现锚 `local-audio-d1-src-20260826.tar.gz` SHA256 `e1ed1e1b…4aae131d`。tombstone 语义:关系重置→
  manifest 回 `revision=0`(设备清动态套回内置音,applied=0=双方单调计数共同重置点,重新生成从 1 计)。

## 凭证/链接（指针,secret 绝不入 skill）

- 三端链接见上表。admin 登录 `admin / ⟨STUDIO_PASS 见生产 /opt/p003/server/.env.local⟩`。
- ⚠️ admin 口令历史散落多处记忆+git 历史,根治待轮换 STUDIO_PASS(见 task-log)。
