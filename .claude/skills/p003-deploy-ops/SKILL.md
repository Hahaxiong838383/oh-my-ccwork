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

1. **server 改**(src/*.ts):**⚠️ 推送前必先 md5 对撞本地↔生产 src 定方向**(2026-08-31 实证:生产直改的人格成长/本地音频/退出90三线 18 文件未回流,本地仓=旧副本,盲推=抹掉生产;倒挂时先拉回流 `rsync --exclude 自己刚改的文件` 生产→本地并 commit,复检「仍不同」只剩自己的改动才推)。然后 `rsync -az apps/server/src/ aliyun-hk:/opt/p003/server/src/`(增量,不 --delete;单文件改动优先只推单文件缩小操作面)→ `ssh aliyun-hk 'pm2 restart p003-voice'`(tsx 直跑,重启即加载新代码)。新增依赖先 `ssh ... 'cd /opt/p003/server && npm i <pkg>'`。新增 scripts/ 要一起 rsync(seed 脚本在 scripts 非 src)。验证 LLM ready 看 `pm2 logs p003-voice | grep LLM:`。
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
- **添加设备手机号预绑(2026-08-31)**:admin 添加表单「家长手机号(选填)」——已注册即绑/未注册设备照加+8s warning(响应 parent_bound/parent_bind_warning);未注册号预建走 `upsertPhoneAccount`(幂等,家长短信登录命中同一账号),绑定必须走 `PATCH /api/admin/devices/:sn/parent`(吃建档同步副作用,别直写 DB);**筛选框≠表单字段**(旧根因)。E2E 测试 SN 形态=`BJP003+YYMMDD(真实日期)+8位`,断 400 必须连 error 文本(同码不同因,只查 status 假绿)。
- **加新设备**:SN 追加进 `DEVICE_SN_ALLOW` → `pm2 restart p003-voice` → 服务器上签凭据:`set -a; . ./.env.local; set +a; npx tsx scripts/sign-device-credential.ts <SN> 30`(输出即凭据,管道接走禁回显/进 git)。
- **新设备接 brain(2026-08-20 起零配置)**:admin 台账加 SN → 点「开通 brain」即完成——身份由房名 SN 自动路由,**无 token 要配**(brain_token 分发已取消,commit af8d3cf0d;开通响应只回 account_id)。设备命令 canary 已全量(env 列表空=sn- 房全开),新设备开箱即用;**二遍 ASR 仍名单制**(火山账单口径观察中):`VOLC_ASR_NONSTREAM_CANARY_SN` 追加 SN 小写+64.90 纪律重启,不加=一遍链路(热词只 100 tokens)。
- **⏰ worker 通行证 2027-08-17 前后过期(定时炸弹)**:过期后 worker 调大脑**静默降级匿名——记忆全失不报错**。提前续:aliyun-hk `cd /opt/p003/server && set -a; . ./.env.local; set +a; npx tsx scripts/sign-worker-token.ts`(唯一签发口)→ 换 64.90 rust-worker.env 的 LLM_URL_QUERY → 纪律重启。role=device token 仅设备房有效(非 sn- 房匿名,probe 污染洞已堵)。
- **pm2 env 事实**:p003-voice 启动参数是 `tsx --env-file=.env.local` → **restart 即重读 env 文件**,老「pm2 env 快照」坑不适用此形态(快照坑只咬 `pm2 start` 时从 shell 继承 env 的进程)。
- **改动后必跑**:`npx tsx scripts/device-session.test.ts`(16/16)+ 灰度先行(`PORT=3005` 同 env 起 staging 打 E2E 再动生产——川哥 2026-08-15 门禁铁律)+ 公网 claims 校验(解 token 对 sub/room/agents/exp)。
- **回滚**:`/root/p003-server-src-bak-20260815-pre-device-session.tgz` + 删 .env.local 尾部 S2B1 段 7 行 → restart → `/v1/device/session` 应回 404。

## 产品首句 v1 单机灰度（2026-09-11 上产，机制详情见记忆 p003_oneshot）

- **两个 env（`.env.local`，改后 `pm2 restart p003-voice`）**：`ONESHOT_FIRST_TURN_SN_ALLOW`（灰度 SN，逗号分隔）
- **B84 第三个 env（2026-09-13，V1.1）`ONESHOT_FIRST_TURN_POLICY`**：`capability`（生产值：任何准入设备 supports 同时含 `oneshot_first_turn_v1`+`local_receipt_v1` 即签首句合同派 firstturn，**不看名单**）/ `allowlist`（默认=只名单）/ `off`（全停=回滚开关）；非法值按 allowlist+warn；三档都要 `ONESHOT_FIRST_TURN_AGENT_NAME` 已配。日志行 `policy= supports=` 可对账老/新客户端。源码 `src/routes/device-session.ts`（分支 `feat/oneshot-first-turn-signing` add34a8db，**2026-09-13 已合 main：merge 93c4bf8b7**；主 checkout 与分支该目录逐字节一致）。部署脚本 `P003-product-definition/docs/scripts/b84-server-policy-deploy-20260913.sh`（先 md5 对撞 93 文件→备份 `/opt/p003/_backup/<ts>-b84-policy/`→换单文件→追加 env→restart→health 轮询+401 探针）。**版本标签**：`p003-v1.0-no-oneshot`/`p003-v1.1-oneshot`（仓里裸 `v1.0.0` 是规则标签别混用），总表 `docs/RELEASES.md`。
- ⚠️ **回滚语义（B87 §3，2026-09-13）**：`POLICY=off/allowlist` 只是**止扩**——老端照常普通语音，但**已开首句工厂的新端（v271+）下一次唤醒会 `first_turn_not_granted` 失败**（端侧强制合同不回退普通票据）。完整回滚=服务端止扩 + 端侧合法停用首句工厂/回退 APK；Worker 回滚前先让票据排空（TTL ≤1h），ordered 房不能派给旧 `rust-worker`。别再写「off=全停、走普通语音」这种一刀切。 **B95 起（v272+，2026-09-13 实测）：off 下新端同次唤醒复用普通票、播「请再说一遍」后普通聊天、零 ordered 投旧池 → `off` 可作普通回退；v271 原包仍止扩。** 切换/恢复用 `P003-product-definition/docs/scripts/b93-oneshot-switch-20260913.sh off|capability|allowlist|clear`（aliyun-hk `/root/b93-oneshot-switch.sh` 同副本；登录 token 只在进程内；**恢复用 `clear` 回 env 状态零变量**，PUT capability 会留 override 行）。窗口内签发人口用房名 epoch 过滤（pm2 日志无时间戳）。
- **B89 后台面板（2026-09-13）**：admin → Worker 区「🧩 版本与 One-shot」= 版本卡（读 `apps/server/release.json`，**发版必更**）+ 三档开关（存 `data/config.db` 表 `runtime_flag` 键 `oneshot_first_turn_policy`，**后台覆盖 > env > allowlist**，秒生效不重启；「清除后台覆盖」回落 env）。API `GET /api/admin/oneshot`、`PUT|DELETE /api/admin/oneshot/policy`（admin 专属）。签发日志 `policy_src=override|env|default` 看来源。测试 `npm run test:oneshot-admin` + device-session B89 段。部署：server 换 `config-store.ts`+`device-session.ts`+`admin-data.ts`+新增 `release.json`（脚本 `docs/scripts/b89-server-deploy-20260913.sh`，锚=三文件 md5）；后台单页走**单文件 cp**（`b89-admin-html-deploy-20260913.sh`，备份 `.bak-<ts>-b89`）。⚠️ 生成部署脚本时嵌入的 md5 **按文件名查字典**，别按位置读 `md5 -r *`（字母序）、别 `set -- $VAR`（zsh 不分词）——2026-09-13 两个坑同时踩，靠脚本自带的锚校验拦住没改任何文件。UI 登录验收归川哥（cc 不输密码），cc 只做 API E2E + 未登录挂载检查（console 无 Vue 错误；`geo.datav.aliyun.com` 403 是原有的）。
  + `ONESHOT_FIRST_TURN_AGENT_NAME`（定向派单目标 agent，现为 `rust-worker-firstturn`）。
  **两者任一为空 = fail-closed**：即使 SN 在名单且客户端声明了 supports，也退回 `contract:null` + 旧 agent `rust-worker`。
  **回滚就是清任一键 + restart**，不需要回滚代码。
- **为什么必须配 agent 名**：`AGENT_NAME` 原是常量，签合同与派单是两件事；只填名单会把 ordered 首句派给
  没有代次状态机的现役 worker，设备发 begin 无人接（codex B29 查出，B30 修）。
- **准入真值（别再去翻 DEVICE_SN_ALLOW）**：`isSnAllowed` = **DB 台账优先**
  （`data/devices.db` 的 `device_registry.status`，active 放行 / disabled 拒绝），
  env `DEVICE_SN_ALLOW` 只是**无台账记录时的兜底**。查台账用 node 不用 sqlite3——
  **服务器上没装 sqlite3**，`2>/dev/null` 会把 command not found 吞成假阴性：
  `node --experimental-sqlite -e '...new DatabaseSync("./data/devices.db")...'`。
- **公网 E2E 姿势**：在服务器上 `npx tsx scripts/sign-device-credential.ts <SN> 1` 签 1 天期凭据（只进 shell 变量），
  curl 打 `https://kidshub-ai.hahaxiong.cc/v1/device/session`，node 解 JWT 断言
  响应 `expected_agent_name` == JWT `roomConfig.agents[0].agentName` == metadata 三字段同源。脚本跑完即删。

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
- **重置(9-1 起两档,执行前必读端点当前实现——行为清单会膨胀,曾从五样静默长到六样差点清掉 G1 rev5 合同冻结物)**:
  `DELETE .../relation-state?scope=persona`=安全档五清一留(relation/style/insight/trait/ledger,**本地音频与 revision 保留**);
  默认(无 scope)=全清六样(+local_audio 条目/文件/revision 归零,设备回内置音)——仅换孩子/儿童数据删除权用。
  admin「🌱 人格成长」tab 两档按钮各带确认框。换绑不同家长自动清五样(不动音频)。
- **admin 人格成长 tab 已重建入仓(9-1,commit 7668e887)**:8-26 原版直改生产 dist 未回流,被后续 web build 覆盖**永久丢失**
  (git+备份全零命中)——**admin 直改生产=孤本引信,一切改动必须过仓再 git show 部署**;重建版七区块(概览/特质/画像叙事/注入实况/音频只读/时间线/操作)。
- **回填**:`scripts/backfill-relation-state.ts --account <id> [--apply]`(dry-run 默认;
  **直查 conversation.db SQL**——conversationStore.list 内部 clamp 1000 条,老账号 first_seen 会算晚)。
- **admin 单文件(in-DOM Vue)改动流程**:dist/admin/index.html 无构建直接改;验证=①标签配平 python 检查
  **对撞原始备份看差异**(基线自带 4 个 parser 假报,绝对数没意义)②部署后开登录页——**渲染成功=Vue
  运行时整树一次编译全模板通过**(新 subTab 模板语法错会全页白屏,不用登录即可验);el-input 必须显式闭合。
- 单测 `npm run test:persona`(115 项);测试选句先对照规则分支(7 字句会触发短句镜像——中性输入要验证过)。
- **说话风格模板(9-1 P0+P2 在产)**:家长选档=trait per-account 基线(`trait_template` 表只存 key,五维/文案在
  `style-template.ts` 随代码走)。四档 default/chatty/quiet/funny;选档特质值**立即置位**+回拉/漂移界锚模板;
  styleRule 进 policy 指令区,**不吃 persona allowlist 门**(家长设置直接生效)。端点 `GET/PUT .../style-template`(含 set_at);
  admin 成长 tab「🗣 说话风格」卡;观测 probe `injection_live.style_template_line` + `trait.baseline`(随档走,9-1 修)
  + 日志锚 `style-template set`/`tpl=1`。重置:all 清模板/persona 保留(家长设置≠成长记账)。
  **E2E/实验用 0002 不用真机**——PUT 覆盖已积累漂移,default 恢复出厂值非原值。现状:003=funny(川哥拍板)/0002=quiet。
  - **P2 白盒**(风格卡内):五维偏移摘要(Δ 相对当前档基线)+归因三色时间线(🟠`parent_style_template`/🟢互动成长/⚪`daily_setpoint_decay`,
    独立拉 `growth-events?module=trait`)+特质卡标题档标。**⚠️ probe 的 injection_live 是 grabLine 白名单抓取——
    orchestrator 加新注入段必须同步加抓取行,否则 probe 恒 null 会误判「没注入」**(9-1 踩过:funny 已注入 probe 不显示)。
  - **P2 生成链**:`buildSystemPrompt`(local-audio-generator,**filler-generator 复用同源**)读 baselineFor+styleRule——
    招呼语/filler 随档走。`LOCAL_AUDIO_GENERATION_PAUSED=0`(9-1 深夜解挂,备份 bak-20260901-style-p2-fullopen);
    手动即跑 `POST .../persona-local-audio-run`(默认 force 绕 PAUSED,烧讯飞 TTS+bump revision)。
  - **allowlist 终态三台** `0010,003,0002`;**004=刘子贤真实儿童设备红线未加**(川哥说「所有绑定设备」时已点名,待显式拍板)。

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
- **SHA 投毒负测(J5,W5 起已迁 file 端点)**:env `LOCAL_AUDIO_POISON_ID=<16hex>` → **file 端点对命中 id
  翻转数据区中间一字节返回**(manifest/bytes/ETag 全真值,投毒态跳 304)——codex 合同禁「同 revision
  manifest 漂移」,老的 manifest sha 翻转法已废。**测完删键+restart**。投毒配好后必跑双锚:正锚=毒 id
  下载 sha≠manifest,负锚=干净 id sha 相符(`scripts/poison-proof.mjs <id> <真值sha>`)。
- **发布语义**:六 slot 各≥2 条才整套原子 commit(凑不齐现套与基准均不动,次日批自愈);新条目 staging(active=0)
  落库 commit 统一翻;同 slot 同文案复用旧音频不重合成。LLM 偶发 `[{"文案"}]` 伪 JSON 已有容错,
  再遇 slot 空手先看 `llm bad-json` 日志的 raw 样本再归因。
- **格式现状(WAV 增量后)**:rev=1=MP3(**冻结回滚锚,永不改写**);rev≥2=WAV PCM16/mono/24k——
  **讯飞 `encoding='raw'` 直出 PCM+server 拼 44B RIFF 头**(机上无 ffmpeg 也不要装);manifest wav 条目带
  `codec=pcm_s16le`+`bits_per_sample=16`;容量门 160KiB/文件+5MiB/revision。item 表 format 列驱动
  Content-Type 与文件后缀。
- **迁移闸 `LOCAL_AUDIO_GENERATION_PAUSED=1`**:挡每日批自动生成(admin force 穿透——手动触发不用删闸)。
  **现状(W4 后)**:闸保持 1=真机验证期发布物冻结;codex W5/W6 全过后删闸+restart 恢复自然节奏。
- **W4 已完成,WAV 首发基线=rev 3**(rev=2 混套废弃——复用判定当时没查 format,已修:复用/补足/兜底三链全限定 wav);
  rev=1 MP3 全套归档 `_backup/local-audio-rev1-mp3-20260826/`(只读,防 14 天 cleanup 清掉回滚锚)。
  **混套检测器**:逐条验 `bytes≈duration_ms×48+44`(WAV 公式;MP3 字节数远小于公式值即混入);
  证据采集脚本 `scripts/w4-evidence.mjs`(公网全链+五字段断言+file 抽检)。
- 单测 `npm run test:local-audio`(127,含姿态组+G1 组);E2E `scripts/local-audio-e2e.mjs off|on` + `scripts/la-admin-e2e.py <SN>`
  (**admin 登录要 username+password 双字段**,只发 password 恒 401);WAV 链离线实证 `scripts/wav-offline-proof.ts`。
  ⚠️ 服务器内联 node -e 多层转义会弄坏剥引号正则(STUDIO_PASS 带引号→login 假败报 unauthorized,误导向鉴权排查)——复杂脚本落文件 scp 跑,别 heredoc 内联双层转义。
  ⚠️ 探针必须落 .ts 文件用 tsx 跑——`tsx -e` 走 CJS 不支持顶层 await。**第二形态(2026-08-31):.ts 落在 /root 等 package.json 作用域外,tsx 照样按 CJS 转(顶层 await 同错)——文件必须落 /opt/p003/server/scripts/ 内**(吃到 type:module),用完删。
- **🔴 探针纪律(D2 起铁律)**:任何 cc 侧探针/curl **禁止带 `applied_revision` 参数**——`last_applied_*`
  是「Android 真机原子应用」的**独占证据位**,己方写入(含写 0)即污染 A3/J2 触达锚(D1 犯过,codex 抓的,已清零)。
- **源码审计锚**:server 无 git,每轮变更出只读 tar+SHA 落 `_backup/`(排除 .env——secret 不入档);
  现锚 `local-audio-d1-src-20260826.tar.gz` SHA256 `e1ed1e1b…4aae131d`。tombstone 语义:关系重置→
  manifest 回 `revision=0`(设备清动态套回内置音,applied=0=双方单调计数共同重置点,重新生成从 1 计)。
- **W5 场景A 后基线(2026-08-26 晚)**:003=v106 `applied revision=4`(greeting 单条增量已闭环:投毒拒→删毒
  差量应用,27 旧 id 零重下载);0010=v105 对照 rev=3。**姿态版=revision 5**(v107 合同的 rev4 编号已被
  场景A消费,codex 预期 applied 数字全部顺延)。**rev5 已 staging 就位**(posture.adjust/no_face 各 4 条+
  投毒预配曾配 `cd52ce494c0c2cdf`——**2026-08-28 已删键**(v133 G1 合同禁毒,值留档负测后置用);
  且 **rev=5 已被 0010 G1 版占用,姿态激活 commit 须 `minRevision≥6`**(commitSet 已支持,等 codex 确认重排)。
  两阶段竞态消除法不变:insertItem active=0 manifest 不可见但 file 可下载,可在设备可见前先验毒。姿态健康门=SLOT_SPECS `requiredRes[]`(必含动作语义,no_face 双成分)+`forbiddenRe`。
  optional slot 语义:0 条=键不存在,1 条=弃置回 staging,2..5 才进套;单测 127(`test:local-audio`,含 g1-1..15)。
- **称呼硬门(2026-08-26「哎子贤」事故后)**:改名走 `nickname_change:{value,evidence}` 五门
  (evidence 子串+句式+值在证据内+代词黑名单);变更查 `growth-events?module=profile`(含证据原句);
  单测 `test:memory-extract`(15)+真 LLM 双锚 `scripts/rename-gate-probe.ts`;数据修复记账 rule=cc_data_fix。
- **称呼硬门 v2 + 不喜欢撤回(2026-09-03)**:门在 `src/rename-gate.ts`(句式三层级 A 显式触发词/B 裸句整句/C ASR 切句,拒绝带 `reason=`,**no_intent 才是真意图可能被拒**,same_as_current/invalid_name 是噪声);撤回在 `src/dislike-undo.ts`(relikes 只认本轮原话+整句无否定)+`memoryItemStore.reviveIfRetracted`(本轮又说不喜欢才复活)。日志锚 `称呼变更`/`撤回不喜欢`/`不喜欢复活`/`改名候选被门拒 reason=`;单测 `scripts/rename-gate.test.ts`(43)+`scripts/dislike-undo.test.ts`(31,临时库);真 LLM E2E `scripts/rename-relike-e2e.ts`(生产机 `set -a; . ./.env.local; set +a; NODE_OPTIONS=--experimental-sqlite npx tsx scripts/rename-relike-e2e.ts`,临时库 14 项,认库终态)。**上句式门前先拿 conversation.db 真实原话回放**(8-26 门 8 天零通过没人发现,见记忆 strict_gate_real_replay)。覆盖面:链上唯一开关 `MEMORY_EXTRACT_ENABLED`(全局,无 per-SN 名单),接入=registry.account_id 非空(写入口=admin 开通/家长 bind-sn 两条,都建档)+`ensureDeviceProfile` 兜底(device- 账号无档当场建空档);新设备零配置即生效。
- **L1/L2/R2（2026-09-03 晚）日志锚与跑法**：`[trait]` 里 `mirror_lsm_session_long|short`（会话级话语量镜像，每场最多一次）；`[recall] reunion account= gap_min= n=`（重逢首轮「上次聊到」，开关 `MEMORY_REUNION_RECALL=0`）/`[recall] concern_due`；账本 rule `profile_field_update`（性格/情绪旧值）、`cc_data_fix`。单测 `scripts/recall-provenance.test.ts`(30)/`persona-state.test.ts`(129)；真 LLM E2E `scripts/recall-provenance-e2e.ts`（生产 `set -a; . ./.env.local; set +a; NODE_OPTIONS=--experimental-sqlite npx tsx …`，临时库）。**E2E 样本里的约定要写成肯定句**（「那说好了，明天讲」），问句「好不好」抽取器按规则不当承诺。memory_item user_version=2（加列幂等，重启即迁移，改前先 cp profile.db 备份）。R1 兴趣三态：日志 `兴趣候选无证据/证据不符被拒`；家长否决 `POST /api/memory/interest/<urlencoded>/veto`；E2E `scripts/interests-evidence-e2e.ts`(10)。R3：`GET/POST /devices/:sn/trait-snapshots|trait-rollback`，日志 `今日有机位移已达上限`/`trait rollback`；admin 改动后验收=登录页渲染(Browser pane 看 console 无 Vue 错，403 是未登录 API 正常)+标签配平对撞 HEAD。记忆白盒：`GET /devices/:sn/memory-whitebox`（抽取流水/因果账本/已撤回）；「记忆没更新」先看流水的 候选→入库 与拒绝原因，再看 `抽取返回空`/`候选全部未入库` 日志；回放诊断法=cp profile.db 副本 + PROFILE_DB_PATH 指过去 + 真实窗口走 extractAndPersist。R5 抽取时机：`MEMORY_EXTRACT_MODE=turn|trigger` + `MEMORY_EXTRACT_TRIGGER_SN_ALLOWLIST`，改后 restart 看启动行 `[memory] extract scheduler mode=`（**/proc/<pid>/environ 看不到 --env-file 注入的键，别拿它验 env**）。模块级定时器（extract-scheduler/insight-runner）一律 `unref()`，否则 tsx 单测进程挂住不退出。
- 🔴 **部署链的门必须是真门（2026-09-03 19:44 崩溃循环 1 分钟）**：顺序固定 `ERR=$(tsc … | grep -c 目标文件); [ "$ERR" = 0 ] || exit 1` → 单测 → rsync → restart → 看 `LLM: ready`+health；tsc 结果**打印不算门**（`set -e` 管不到管道里的 grep）。「只加一行日志」也走全链。崩溃循环回滚：`git show HEAD~1:<path> > /tmp/x && scp /tmp/x aliyun-hk:<path> && pm2 restart`（~60s）。insight-runner.ts 含 NUL 字节，改它用 python bytes 替换。本地音频：解挂/暂停看启动行 `local_audio_paused=`；预测明日触发用 `shouldRegenerate(state, tierNow, traitsNow, tomorrow3, routineRefreshDays)` 在生产只读跑。**每日批「今天跑过」已落库 `job_run(job, day)` + 2h 租约（2026-09-03 22:10 起，`src/job-run-store.ts`），部署重启不再补跑**——之前只在内存，当天实测补跑 5 次：洞察/叙事无同日守卫，账本刷进 56 条同义改写假事件（已备份清除）。要立刻生成用 admin force / 脚本 force，别再靠重启。**上线当天/人工确认已跑过 → 必 seed**：`set -a; . ./.env.local; set +a; NODE_OPTIONS=--experimental-sqlite npx tsx scripts/job-run-ops.ts seed <day> <startedISO> <finishedISO> <note>`；探针 `job-run-ops.ts peek [nowISO]`（真 decideDailyRun 干跑）/`show`；日志锚 `[persona-daily] day=… 今日已跑过 跳过`（每小时 tick 都会打一行，没这行=timer 没跑）/`上次认领未完成(疑似进程崩溃) 重新认领`。快照每日路径改 INSERT OR IGNORE（同日只留 3 点档回落前那份，退回按钮的「存今天」显式覆盖）。**profile.db 是 WAL 模式，`cp profile.db` 备份会缺未 checkpoint 的页（当天 WAL 4MB）——备份用 `VACUUM INTO`**（node:sqlite 一行）。端侧发现窗 04:00–06:00 按 SN 散列。对账：`scripts/la-reconcile.ts <日期>`（读 `local_audio_fetch_log` + 账本 module=local_audio + state），给 codex 的表直接贴。**给 admin-data 加路由时 helper 名先 grep 原文再用**（`normalizeSn` 不存在，路由用 `c.req.param('sn').trim()` + `deviceRegistryStore.get`）。
- **看「本次重启之后」的 pm2 日志**(out log 无时间戳):`tac $OUT | awk '/LLM: ready/{exit} {print}' | tac`——别用 `awk 'f;/LLM: ready/{f=1}'`,它锚在文件里**第一次**重启(2026-09-03 我这么写把窗口放大到几天前,门拒旧格式行混进来)。**回流对撞要连 scripts/ 一起**:`md5sum scripts/*.test.ts` 两侧清单 join 找「只在生产/内容不同」(8-31 只回流 src,本地跑的 memory-extractor.test 是过期套件)。
  ⚠️ `test:onboarding` 挂在 package.json 但文件不存在(存量断链)。
- **命令词禁入门(2026-08-27)**:本地音频/filler 文案生成禁含设备命令别名(254 词快照 `assets/device-command-words.tsv`,每日批经 hotword 通道 device_aliases 自动刷新)+急停/退出词(farewell 豁免退出词);存量扫描 `scripts/scan-echo-words.ts`(只读,新门上线/词表变更后跑);曾真扫出 staging「开灯啦」1 条雷已删。备份 `_backup/20260827-*-pre-echo-words`。
- **G1 奖励线 rev=5(2026-08-28,0010 only)**:六个 `g1.*` optional slot 各 3 条随 revision=5 发布(003=v107 控制组零触碰);
  发布入口 `scripts/g1-rev5.ts stage|commit`(两阶段;commit 内置禁毒断言+minRevision=5 跳号),
  证据探针 `scripts/g1-evidence.mjs baseline|full`(35 项:合同 §4 六项+003 逐字节恒等+旧毒 id 活体无毒;全程不带 applied_revision)。
  **G1 字数口径 6–9 字非合同建议的 8–20**(duration 1..2200ms 硬门实测互斥:8字=2000ms/10字必死;教训→rg 软约束);
  buildSlot 有 promptSuffix 参(抽取 LLM 确定性,重跑必须换提示不然白烧 TTS)。发布档案 `_backup/20260828-g1-rev5-release.txt`,
  代码备份 `_backup/20260828-pre-g1/`;J1 回执 `CC_P003_G1_LOCAL_AUDIO_V133_J1_RELEASE_20260828.md`。
- **file 限频容量(2026-08-28 J2 活锁事故后)**:默认 `LOCAL_AUDIO_FILE_RPM_DEFAULT=120`(route 导出,env 同值双保险 .env.local:149);
  **合法峰值=冷同步整套全量下载**(rev5=48 文件,客户端原子性:不完整 staging 整套弃),抽查探针验不出限频缺口,
  **要打到峰值+1**(35 连发全 200 才算验过);单测 cap-1=默认≥slot枚举×5×1.5(枚举扩容先翻红);
  回滚=env 显式调小,route 源码锚 `_backup/20260828-pre-g1/local-audio-route.ts.pre-rpm120`。
- **回声自嗨排障(2026-08-26)**:现象=设备命令确认语播完后小可自问自答→查 64.90 worker 日志
  `journalctl -u voice-worker-rust | grep "echo suppressed"`(对撞门在产,窗 ECHO_SUPPRESS_WINDOW_MS=800,
  0=关门回滚);机理/两分布定参依据→记忆 project_realtime_voice_agent「回声对撞门」段;
  端侧 AEC 根治调研球在 codex(`CC_P003_AEC_ANDROID_ANALYSIS_REQUEST`)。
- **filler 人格套(F1)**:双机 27 条已发布 64.90 `/opt/voice-agent/fillers-persona/<SN>/`,
  **F2 前 worker 不读=听感不变**;发布 `scripts/filler-publish.ts <SN> [--dry-run]`(留档 data/filler-sets/);
  64.90 通道 `apply_hotwords.py action=apply_fillers`(**barge 桶硬拒**);colleague 全局套=回滚锚零改动。
  详见记忆 p003_filler_persona。

## 凭证/链接（指针,secret 绝不入 skill）

- 三端链接见上表。admin 登录 `admin / ⟨STUDIO_PASS 见生产 /opt/p003/server/.env.local⟩`。
- ⚠️ admin 口令历史散落多处记忆+git 历史,根治待轮换 STUDIO_PASS(见 task-log)。
- **admin「🎙 语音链路」页(2026-09-03 晚上产,川哥:供应商/方案/密钥后台手动配,不再找 cc 改 env)**:链=admin(WORKER_NAVS `voice`,字段表由 server `VOICE_FIELDS` 单源渲染) → `GET/PUT /api/admin/worker-voice`(admin-data.ts `VOICE_RW_KEYS` 23 键白名单+窄正则+`VOICE_RANGES`,后端为真防线;LiveKit 安全窗口 409;应用后对撞 非密钥比值/密钥比 len;密钥永不回显不进日志,只记 keys) → 热词发布同一把 forced-command key → 64.90 `apply_hotwords.py` `voice_get/voice_set`(python 侧 `VOICE_KEYS` 同形白名单=最后一道;**只写 `rust-worker.env` 覆盖层**,EnvironmentFile 末位赢,python 线 `.env` 只读参考绝不写;快照 `rust-worker.env.bak-voice-<ts>` 留 10 份 → 原子写 → 纪律重启 → 健康自检(registered worker 锚+无 panic) → 失败自动回滚再拉起)。**可选项由 worker 二进制决定**:识别只有火山(`stt_volc.rs` 唯一实现,二进制里连 STT_PROVIDER 串都没有),合成 volc/xfyun(`tts.rs` build 匹配)——换别家仍要写代码。**加新键三处同改**:TS `VOICE_RW_KEYS`+`VOICE_RW_RE`(+`VOICE_RANGES`)+`VOICE_FIELDS` 一行、python `VOICE_KEYS`、测试 `worker-voice.test.ts`(字段表全覆盖断言会红)。**回滚**:恢复 64.90 `rust-worker.env.bak-voice-<ts>` + `restart-worker-envonly.sh`;脚本回滚 `apply_hotwords.py.bak-20260903-voice`。**E2E 真通道**(22:49 实测 9.1s):server 上 python 登录 → GET(32-hex 泄漏扫描=0) → PUT 坏值 400/白名单外 400 → PUT 同值 no-op `VOLC_ASR_END_WINDOW_MS=150` 不带 force(0 房间过安全窗口)→ worker 新 PID+registered 锚 1+panic 0+bak 文件;服务端锚 `[admin-voice] applied keys=…`。**⚠️ 路由测试在生产跑别 `source .env.local`**:shell 带 LIVEKIT_* 时 `fetchLiveKitRooms` 真查到 0 房,测试里「不可达→409」变 200/502(worker-race/worker-voice/hotword 三套已显式 `delete process.env.LIVEKIT_*`,但新写的测试别再假设环境);**admin 标签配平对撞 HEAD 时 `git show HEAD:` 路径要从 mycc 仓根写**(`2-Projects/P003GameDemo20260513/apps/web/…`)——从子目录写相对路径 git 静默出空串,「HEAD 零错」是空壳(当晚实撞;真 HEAD 本身有 6 个历史未闭合 div,判据是 work-head 逐标签增减=0,不是绝对零)。
- **PCK 双 OTA(2026-09-04 J1 上产,合同 CODEX_P003_APK_PCK_DUAL_OTA_SERVER_CONTRACT_20260903)**:代码 `src/pck-inspect.ts`(Godot4 PCK 解析+门)/`src/pck-store.ts`(四表)/`src/routes/ota-pck.ts`(check 增量+文件接口+admin);check 响应恒带 `content_update`。文件接口走 **Hono 验 Bearer → `X-Accel-Redirect` → nginx `location ^~ /_pck_internal/ {internal; alias /opt/p003/ota/pck/;}`**(env `PCK_SERVE_MODE=xaccel`;无 nginx 时 `direct`=Node 自流式,单测用 direct);**X-Accel 出流的 access log 记原始 URI**,查 `grep '/v1/device/ota/content/files/' /var/log/nginx/kidshub-ai-ota.log`,别 grep `_pck_internal`(那只会看到外部探测的 404)。admin OTA 页三卡:上传(query 带 content_version/product_models/min_launcher_version_code/notes,raw body)/版本发布(草稿→发布→暂停/恢复→撤回;回滚=建新 revision 同 SHA;删除只允许草稿/已撤回)/设备状态(冻结/日志)。**E2E 配方**(01:06 实跑):server 上 `tsx -e` 用 `buildPck` 造 200KB 包 → admin token PUT upload → `sign-device-credential.ts <SN> 1` 取凭据进变量(不打屏) → 灰度发布到该 SN → check 带 content_state 看 offer → 公网 `curl -I`/`-H 'Range: bytes=0-99'`/全量 sha 对撞 → pause(check null,文件仍 200) → revoke(410) → DELETE 清掉。测试 `NODE_OPTIONS=--experimental-sqlite npx tsx scripts/ota-pck.test.ts`(74)+`ota.test.ts`(30)。回滚:nginx 备份 `_backup/nginx-kidshub-ai.bak-*-pre-pck` + `ota.db` 备份 `_backup/*-pre-pck/`。**nginx 内部 location 不要再 `add_header Accept-Ranges`**(静态出流自带,会重复)。
- **admin「设备接入」资源卡(2026-08-27)**:数据链=前端 loadWorkerStats → `/api/admin/worker-stats`(server 30s 共享缓存) → 专用 key `worker-stats-key` ssh 64.90 forced-command `stats.sh`(第三把 key,与 hotword-apply/aiops 并列)。前端 60s 自动轮询+「更新于」小字(此前只在进页拉一次,标签页挂夜=显示打开时刻旧快照,川哥实撞 711M)。**stats.sh 采集本身永远实时**——资源卡数字可疑先看「更新于」时刻,再逐跳对撞。admin 改动部署=git show 导出→scp(路径要 mycc 仓根相对)。
- **OTA 强制更新按钮(9-2)**:admin OTA tab 每行「⚡强制更新/取消强制」=publish 端点 force+immediate/idle_only,灰度范围原样保留。E2E 用低于全部设备当前版本的旧 release 做开关闭环(resolveUpdate 取 >设备值最高命中,旧版零影响),测完恢复四字段;serve 字节流 md5 对撞 dist。releases 真值看 `GET /api/admin/ota/releases`(9-2:v184 全量/v183·v179 force+immediate 灰度 0002,0010)。

## 小可世界观/玩法知识库运维（2026-09-02，机制详情见记忆 p003_worldview_kb）
- 位置 `src/xiaoke-kb.ts`（13 条 `KB_ENTRIES`，关键词子串召回 <1ms，`MAX_RECALL=3`，命中附真实性红线）；测试 `npx tsx scripts/xiaoke-kb.test.ts`（12 项）。加条目=改代码+加正负锚+server rsync 单文件+restart。
- **时效纪律**：数据源手册 docs/12 停在 6-11；每次 Godot 玩法发版（OTA 发布文档）必附「小可需知」段并同步 KB——**反查法**：拿新功能独有词 `grep -c` 手册/xiaoke-kb.ts/prompts.ts，0 即缺口（9-2 实证「金币」0/0/0，G1 上线三个月小可不知金币）。
- 实时数字：KB 明文「不知道实时数量」；接入路线=遥测 SnapshotSchema 加 `game` 子对象（telemetry.ts）+ EVENT_TYPES 加 g1 六事件，KB 命中游戏话题时附一行实时状态（方案文档 2026-09-02-小可游戏玩法知识接入方案）。

## 跨端日志对撞真值（2026-09-02 2b M0 实证）
- 设备房名 `sn-<SN>-<秒>` 的秒由 server `device-session.ts` `nextRoomSecond()` 生成（`floor(Date.now()/1000)`，同秒碰撞 +1）→ **第三方钟锚**：Android `session_bound` 必在造房之后，它记录的时间早于造房秒 = 设备钟慢（003 实测 ≥1.3s）。跨端对撞主键用 trace_id（server `[device-session] ok … trace=` ↔ worker `trace_id=` 同值），时间只做辅。
- pm2 `p003-voice-out.log` 的行**没有时间戳前缀**（实测），对时间只能靠 worker journal 或 server 行内自带的 ts 字段；别拿 pm2 行做时序证据。
- 2b 联调状态与 worker 侧真值以 memory `project_p003_device_command_evolution` 为准（rg `2b|EXECUTE|candidate`）。

## 灰度/白名单全覆盖现状（2026-09-02 晚，4 台=内部测试样机）
- 接入：DB `device_registry.status=active` 为准（4 台），env `DEVICE_SN_ALLOW` 只是 DB 无记录时兜底。
- 遥测：`TELEMETRY_SN_ALLOWLIST=`（空=放开，`telemetryAllowed` 先 DB status 再 env）；备份 `.env.local.bak-20260902-telemetry-fullopen`。server 开了≠端侧在发：看 `[telemetry] batch sn=****XXXX` 行；端侧开关归 codex。
- 人格成长：`PERSONA_STATE_ACCOUNT_ALLOWLIST`=0010/003/0002，004 未进（川哥 9-02 定性 004 为测试机，「先不管」）。本地音频包只有 0010/003 有（rev5）。
- 改 `.env.local` 后 `pm2 restart p003-voice`（`--env-file` 是 node 参数，重启即重读；pm2 自身 env 快照坑不适用于此键）。验：`pm2 describe` restarts +1、`curl 127.0.0.1:3001/health`=200、启动日志 ASR/LLM/TTS ready。

## 灰度盘点 SOP（2026-09-02 定型，问「还有哪些没覆盖全部设备」时用）
1. **源码枚举开关**：worker `git grep -oE 'env::var\("[A-Z0-9_]+"\)' feat/rust-worker -- rust-worker/src`；server `grep -rhoE 'process\.env\.[A-Z0-9_]+' src`，过滤 `CANARY|ALLOW|ENABLED|_SN|PAUSED|OVERRIDE`。别从记忆列——记忆里没有的门每次都有。
2. **活体值**：worker `/proc/$(systemctl show -p MainPID --value voice-worker-rust)/environ`；server `.env.local`（node `--env-file` 不落 environ，看文件+pm2 args）。
3. **库表级范围**（`/opt/p003/server/data/*.db`，无 sqlite3 CLI，用 `node -e` + `node:sqlite` readOnly）：`devices.device_registry`（绑定真值，status=active）/ `ota.ota_release.rollout_sns`（空=全量）+ `ota.ota_device_status`（设备自报版本）/ `profile.trait_template|trait_state|relation_state|local_audio_state`（人格线谁有状态）/ `telemetry.*` group by sn / `config.device_config`（scope）。**时间列单位先 `select min,max` 探**：`device_session_log.created_at` 是毫秒，registry `created_at` 是秒。
4. **逐台填格子**：每项「覆盖 x/N + 开全动作」；空值语义逐门读消费者（`commands_gate` 空=设备房全开；`CANARY_SAY_IDENTITY_ALLOW` 空=全拒；`TELEMETRY_SN_ALLOWLIST` 空=放开但先看 DB status）；名单里不在 registry 的 SN 报「脏」。异常（版本/定性冲突）交川哥定性，不自行处置。

## 每日批巡检 + 无登录验证技法（2026-09-03 定型）
- **每日批健康判据看产物不看运行**：`node -e`（node:sqlite）查 `profile.local_audio_state.last_generated_at`/`revision` 与 `growth_event` 最近 `daily_*`；再数 pm2 日志终态分布 `grep -aE '\[local-audio\] gen (start|commit|abort|skip)' | sed 's/account=.*\([0-9]\{4\}\).*/\1/' | sort | uniq -c`——只有 start 没 commit = 空转。pm2 out 无时间戳，时序用 DB `created_at`（毫秒）或行号相对位置。
- **一次性验证脚本走生产真路径**：文件放 `/tmp/x.mts`（`.ts` 在 /tmp 会被 tsx 当 CJS，top-level await 报错），`await import('/opt/p003/server/src/xxx.ts')` 绝对路径，`NODE_OPTIONS=--experimental-sqlite npx tsx --env-file=.env.local /tmp/x.mts`。只调贵分支前有门的函数（如 `runLocalAudioForAccount` 被预检拦住=零合成），用完 rm。
- **admin in-DOM Vue 改动的无登录验证**：Vue 挂载时编译整棵根模板（含 v-if 未显示分支），所以 Browser 打开 `https://kidshub-ai.hahaxiong.cc/admin/`（⚠️ 不是 p003.hahaxiong.cc，那是 SPA 兜底假 200）出现登录框 + 控制台无 `[Vue warn]` = 模板语法过；登录后交互留给川哥（不代输密码）。投放 SOP 不变：commit → `git show HEAD:apps/web/public/admin/index.html` → 备份 `.bak-<date>-<tag>` → scp → md5 对撞 dist 与 URL。
- **设备配置加 server 自用键**：`CONFIG_KEYS` 加行并 `serverOnly: true`（不进设备快照、不参与设备 revision、admin 总览标「仅服务端」）；admin 页已按键表通用渲染，加键零前端改动；改 `device-config.test.ts` 的 srv-* 负锚随之验。

## 本地音频灰度发布 SOP（2026-09-03 rev6 003 实跑）
1. 挡每日批：`.env.local` `LOCAL_AUDIO_GENERATION_PAUSED=1`（备份 `.bak-<date>-localaudio-paused`）+ 会话外 `pm2 restart`；admin force / 脚本 force 不受此闸限制。
2. 只发目标账号：`/tmp/x.mts` 里 `runLocalAudioForAccount('device-<SN>', { force: true, reuseStagingFirst: true })`（staging 优先复用=零 LLM/TTS；`PUBLISH_ITEMS_PER_SLOT=2` 预算，14 槽×2×160KiB=4.375MiB 硬证明在 5MiB 门内）。
3. 发布锚（store 层即可，无需设备凭据）：`getState().revision`、`listActive()` 逐槽计数与去重 bytes、`buildManifest()` 两次 JSON 相等 + sha256 指纹、抽检 `readAudio()` 的 RIFF/WAVE 头 + sha256==item.sha256（=file 端点 ETag）。探针**不带** `applied_revision`。
4. 端侧受控同步由 codex 触发；对撞 `[local-audio] manifest sn=****XXXX revision=N applied=N` + `file … 200` 计数。通过后 `PAUSED=0` + 重启 → 其余账号在沪时 3 点档自动出新套。
5. **上限 5MiB 是合同不是配置**：Android parser 硬门 + 12MiB 双 revision 预算，server 单边提额=端侧整套拒收静默用旧套；提额必须双端同版本+重做包级 M0。

## 语音调档（孩子说一句切风格档，2026-09-03 Phase A）
- 键：`.env.local` `STYLE_VOICE_MODE=off|observe|execute`（默认 observe；改后 `pm2 restart`）。词表/处置在 `src/style-intent.ts`；防抖 10min/日 3 次进程内（重启清零只放宽一次）。
- 锚：`pm2 logs p003-voice | grep '\[style-intent\]'`（observed/executed/suppressed，不带原话）；账本 rule `child_voice_style`（admin 成长 tab 时间线 🔵）；GET style-template 的 `source`。
- 测试：`NODE_OPTIONS=--experimental-sqlite npx tsx scripts/style-intent.test.ts`（语料改了必跑）。词表增删：只收「关于小可说话方式」的显式形态，内容诉求（讲个笑话）不进；含糊句留 S2。
- **admin 加子页/枚举值的纪律**（2026-09-03 成长页串台实证）：新子页的加载要同时挂进 `selectBrainDevice`（点选设备）与 `refreshBrainTab`（顶部刷新）两处派发；切换先 `resetGrowthView()` 类清旧视图再拉，宁可短暂空白不要安静错着。
- **语音调档实测判据**：看状态不看回复——`[style-intent] executed` + `trait_template.source=voice` + 账本 `child_voice_style`；LLM 会替漏召回的意图口头答应（「那就多聊两句」），回复内容不作证据。
- **admin API 真通道 E2E（不登录浏览器）**：脚本必须放 `/opt/p003/server/scripts/_cc_xxx.mts`（放 /tmp 解析不到 `hono` 等包），内建 `new Hono()` 挂 `authRoute`+`adminDataRoute`，用 `--env-file=.env.local` 的 `STUDIO_USER/PASS` 走 `/api/auth/login` 拿 token（凭据只在进程内，不打印），再 `app.request` 打管理端点；用完 `rm`。mock 单测（`HOTWORD_CHANNEL_MOCK`）管形状，这条管真通道。
- **forced-command 脚本改动 SOP**：真源 `feat/rust-worker:…/rust-worker/ops/apply_hotwords.py` → `py_compile` + 正则自检 → scp 到 64.90 `.new.py` → 远端 `py_compile` 后 mv 覆盖（先 `.bak-<date>-<tag>`）→ 从 aliyun-hk 用真 key `echo '{"action":"race_get"}' | ssh -i /root/.ssh/hotword-apply-key root@64.90.13.117 apply` 验只读动作 + 未知 action 仍拒。
- **虚像距离回读失真联调（2026-09-04，003）**：设置 UI 显示 2.5m（按 MCU 最低点位 FF 显示，**是陈旧假读数**）/ 遥测恒 12 = raw 120 = **真在远端**（固件远端常量 120dm；传播口径 2–10m 不是固件量程）/ Android 对 label 35 回 `boundary_reached` **属实**。根因=MCU 0x0100 帧 raw=120 + lowestPoint=FF 双边界冲突（codex 09:43 全行程实证：镜面距离 411→423mm 远端钳位、raw 随实体连续变化），FF 为何陈旧归固件侧；v217+ `VirtualImageState` 显式冲突态（null/uncalibrated/mcu_boundary_conflict，遥测不得报 2.5 或 12/valid；远端边界只在低位未触发∧raw=120；冲突态只允许用户显式「更远/最远」单次执行；**不做自动校准**）。worker 入站只有 `device.command.result`、无状态回读通道；v217 result 增量字段（规范化读数/来源/`image_distance_boundary_conflict`）worker 需加日志透传。我的反向误判教训 → memory `feedback_ui_reading_is_not_physical_truth`（联调单 `CC_P003_VIRTUAL_IMAGE_READBACK_MISMATCH_20260904`，codex 回执 `CODEX_P003_VIRTUAL_IMAGE_AND_PCK_J1_REPLY_20260904`）。三方对撞 `scripts/vi-collide.sh [SN后四位=0003] [N=6] [since=-2h]`（本机跑，只读 64.90 journal + aliyun-hk telemetry.db，不动设备）；v217+ 真人顺序（起点 raw30+FF 真最低；v216 把 raw30 报 3.0m，v217 最低=2.5m）：近一点(34)应 `boundary_reached` 且 UART TX=0 → 远一点(33)仅一帧 `0x010C UP 5dm` 回读 35 → 近一点回 30+FF → 三步过了才「最远」(35，一帧 `0x010D=120`) → 再 PCK J2 003 canary。0x0120 `00 11 00` 语义本机协议 V1.3 未定义（只定义级别/模块/data），归固件侧。worker 边界句 `device_reply` 只按动作名含 `up/max/farther` 判措辞，`virtual_image_farthest` 落「已经到最低了」= 待修（应按动作族：虚像 最远/最近）。
- **worker 换装 SOP 补两条（2026-09-04）**：①**活跃会话门可算**：自 `systemctl show -p ActiveEnterTimestamp` 起，journal 计 `job assignment received, spawning job task` − `job closed` − `job failed` = 0 才跑 `deploy-worker-bin.sh`（脚本本身不查会话，直接 stop）；②home-studio 构建通道：`git push home-studio-mesh:mycc <branch>:refs/heads/tmp/<x>` → 那边 `git worktree add /tmp/<x> tmp/<x>` → `scripts/build-local.sh`（预热后增量 16s）→ 产物经本机中转 scp 到 64.90 `/root/rust-worker/voice-rust-worker.new`（不是脚本提示的 `/root/`）；**再次 push 同名分支会被拒（分支已被 worktree 检出）**，换名 push 后在 worktree `git checkout` 即可。本轮锚：`ce06e87e4` md5 `838ff13e…`，纠正句/边界句真机未触发，验收在 v217 联调单第 1/5 步。
- **PCK 真包两坑（2026-09-04 J3 首上传即撞）**：①Godot **4.6.1 导出 = pack format 3**（头多 `dir_offset`，目录不紧随头部）——合同示例/自造 V2 包过 74 向量≠真包能上传，**门第一次吃真包前不算验过**；②V3 目录路径**不带 `res://`**，manifest 正文带，比对前两边 `normalizePckPath`。上传后必看 `manifest_found=true required_resources=N` 且与 codex descriptor 集合相等（`/opt/p003/_inbox/*.manifest.json`）。J3 台账：release#4 v214 published sns 003 / #5 j3 draft；`OTA_CHECK_RPM=12` 为生产基线（探针：同 SN 60 s 13 次 → 12×200+429）。
- 🔴 **PCK 发布语义（2026-09-04 11:22 事故后）**：设备目标 = **最新且适用**的 published release；同版/待装/文件缺失一律不下发、**不回落旧版**（只有名单/机型/最低 Launcher 不匹配才看更早的）。降级只能显式：撤回/暂停新版，或 rollback 端点生成**更新的** revision。**别用「保留旧 published」当 same_version 探针**——新版激活后旧版会被当更新（修前）或至少制造歧义；验 same_version 用「唯一 published = 设备现役版本」即可。止血开关：撤回 release（文件 410）+ 冻结 SN（判定 frozen）；冻结不拦已接受的 pending 下载。修复 `de5f7718f`，向量 pp-0..11，100/100。

## 设备感知协议 prompt 变更 SOP（2026-09-04 数值→最值禁映射上产实跑）
- 文件 `src/device-brain-prompt.ts` `DEVICE_INTENT_PROTOCOL`（env `DEVICE_INTENT_OBSERVE=1` 才注入，生产=1，`LLM_PROVIDER=race`）。改规则 → 单测 `npx tsx scripts/device-intent-protocol.test.ts`（断言认原文措辞，改措辞要同步断言）→ tsc 目标文件 0 错 → `_backup/<ts>-pre-*/` → rsync 单文件 → **先在生产跑真 LLM E2E 再 restart**：`set -a; . ./.env.local; set +a; npx tsx scripts/device-intent-prompt-e2e.ts`（直接 import 新 src + 同一 provider 工厂，不需重启；8 用例，每例最多重试 1 次；概率抽样非零误触发证明）→ 64.90 活跃会话=0 门 → `pm2 restart p003-voice` → restarts+1/health 200/`LLM: ready`。本轮锚：md5 `1bdc7185…`，回滚 `_backup/20260904-141306-pre-intent-numeric/`。
- 坑：LLM 会吐**空标记 `[[DEV:]]`**（「音量调到60」实录），worker `DevMarkStripper.complete()` 对空 inner 返回 None=整段放行→会进 TTS/字幕；prompt 已加「决定不输出时什么都别写」，worker 侧修复另开任务（feat/rust-worker）。回复里 LLM 仍会说「这就给你调到最远啦」这类承诺句（规则 4 压不死），纠正靠 worker 结果短句，别指望 prompt。
- **PCK 身份门 + F1 注入开关（2026-09-04 14:26 上产）**：`release_sequence` 只在 publish 分配、启动回填按 published_at（日志 `[pck] backfill release_sequence release#N seq=M`）；候选按序号倒序，`sequence_not_newer` 不回落——**撤回新版不会让旧版自动回来，要降级建 rollback revision 再发布**（admin 台账 `transition_kind=rollback`）。F1 注入不改 nginx：`POST /api/admin/ota/pck/fault {sha256,recover_after_s,arm_ttl_s}` / GET / DELETE；先武装再 publish 才能撞到首个文件请求；日志锚 `[pck] FAULT armed|500|recovered|cleared`；进程重启即清。ota.db 备份用 node `VACUUM INTO`（WAL）。部署链同 server 通用：md5 对撞 HEAD↔生产 → 备份 → rsync 三文件 → 生产跑 `ota-pck.test.ts`(128)+`ota.test.ts`(30) → 64.90 活跃会话=0 → restart → health + 回填日志。
- **F1 实跑锚（2026-09-04 14:46–14:52 PASS）**：`POST /fault` 目前只接受已发布/暂停 sha → 「先武装再发布」会 400，实际只能 publish→arm（本轮 33 s 空窗无漏，靠 003 处于长周期 check 且 codex 手动触发）；改接口允许草稿后再按原序。观察用两个后台看守（keeper 每 20 s 在 fault=null 且未命中时重武装、首次命中即停；watcher 每 10 s 记投影/fault/流水，到 confirmed 退出）——watcher 里 python 解析空响应会 traceback 一次，无害。设备两次 500 前没收到字节 → 第三次全量 200 非 206。
- **PCK 回滚语义（2026-09-04 15:17 改）**：`/releases/:id/rollback` 已 410；回滚=codex 出内嵌 manifest 自洽的新包 → upload（门：`manifest_content_version`==描述符，否则 400 `manifest_identity_mismatch`）→ `PATCH /releases/:id {rollback_of:<id>}`（草稿期）→ publish 拿新序号、`transition_kind=rollback`。设备报 `rolled_back` 后该版本对该机 `rolled_back_by_device`（同一次 check 生效），显式再 publish/resume 才解除——所以 F2 里「收到 rolled_back 立刻 revoke」只是收尾。
- **PCK F2 回滚链真值（2026-09-04 15:42 003 实测）**：`rolled_back` 上报字段 **from=恢复后的现役、to=被放弃的候选**（合同冻结，v221 若加可读字段用 `restored_version/abandoned_version` 增量，不反转）；服务端 from/to 两向计入再剔除现役，与顺序无关。熔断证据链：上报的**同一次 check** 台账 `last_decision=rolled_back_by_device`（该判定不进流水、下一次 check 就被覆盖，要抓得靠看守每 10 s 轮询 devices，或看「新版仍 published 期间无 offer 行」）；撤回 release 只是收尾。`activation_state=rolled_back` 是最近一次迁移终态，运行态联合 `active/pending/last_decision` 判读，别单看它报红。看守脚本形态见 scratchpad `p0/f2-watch.log` 的命令（devices+log 轮询、见 rolled_back 自动 revoke 指定 release、55 min 上限）。
- 🔴 **admin 手传 PCK 413（2026-09-04 16:36 修）**：nginx server 级 `client_max_body_size 2M`，大包体只对显式 location 放开——APK `location = /api/admin/ota/upload` 300m，PCK 现加 `location = /api/admin/ota/pck/upload` 40m（PCK 硬顶 32MiB）+ `proxy_request_buffering off`。**新增任何大包体 admin 接口都要配 location，别指望 `/api/` 通配**。教训：我导入 PCK 全走服务器本机 127.0.0.1:3001 直连 Node，nginx 那跳从没被验过，用户第一次在 admin 页手传就 413——**上传类接口的 E2E 必须过公网 nginx**，探针用「3MB 包体 + 坏 token」：413=被 nginx 拦，401=包体放行进鉴权（否定对照先做一次）。`systemctl reload nginx` 返回后旧 worker 仍在 shutting down，**紧接着的探针可能还走旧配置，隔几秒复测三次才作数**。备份 `_backup/nginx-kidshub-ai.bak-<ts>-pre-pck-upload-413`。
- **APK/PCK 扩面观察（2026-09-04 16:14–17:36 三台实测）**：PCK 从 offer 到 confirmed ≤4 min（主要等无人 30 s 重启）；APK idle_only 安装**可能等很久且服务端看不出原因**（0004 下完 40 min 后才装，设备前无人；门是端侧摄像头权威 fail-closed + 前台/语音/播报阻断）。判「设备活着还是卡死」别用 OTA check（长周期静默），用 pm2 `[local-audio] manifest sn=…XXXX`（每分钟一拉）或 worker journal 房间行；遥测不是每台都有（0002/0004/0006 历史 0 行）。**探针禁用真机 SN 打会 upsert 设备行的端点**（10:58 RPM 探针把 0002 写成 212/rpm-probe，六小时后被当事实引用）。Monitor 形态：远端 60 s 轮询 devices/pck devices/releases 三接口做 diff 只吐变化行，失败签名 install_failed/rolled_back/failed 必在过滤里。
- **遥测 `device_command` 事件（2026-09-05 10:08 上产，合同 v3.1 §4）**：`telemetry.ts` EVENT_TYPES + `DeviceCommandDataSchema.strict()`，失败逐条 `invalid_event_data` 不影响同批；测试 `scripts/telemetry.test.ts` 37（dc-1..8）。**线上验新门用负向探针**：真机凭据 + 带多余键的 device_command → 新代码答 `invalid_event_data`、旧代码答 `invalid_event_type`，被拒事件不入库=零污染；别用正向模拟事件（会以真机 SN 入库）。
- **本地音频设备回复十八槽（2026-09-05 11:38 上产）**：文本真源 `src/local-audio-device-reply.ts DEVICE_REPLY_TEXTS`（与 worker `device_reply` 话术表同表，改文本先改合同）；工具 `set -a; . ./.env.local; set +a; NODE_OPTIONS=--experimental-sqlite npx tsx scripts/local-audio-device-reply.ts device-<SN> stage|publish|report [--json 路径]`——stage 只入 staging（active=0，现役 revision 不动），publish 显式出新 revision（十八条不齐/候选 >5MiB 拒）。候选预算按 `buildManifest` 实际引用集合∪十八条去重求和（别用「每槽最近 2 条」视图）。staging 14 天未发布会被 cleanup 清，重跑 stage 同文本复用同 id。交付给 codex 走 `/opt/p003/_inbox/local-audio-device-reply-<sn4>-<ts>.tar.gz`（wav 按 `device_reply/<slot>__<id>.wav`）。
- **设备回复音频发布时序（codex 2026-09-05 验收回执）**：旧 APK 解析器忽略未知槽但会记下 revision+ETag，先消费新 revision 后换新 APK 会 304/同 revision 漂移保护卡死 → **先新 APK 上机，再 publish 新 revision**；发布前核 `last_applied_revision` 与最近 manifest 拉取来自新 APK；误发只能出更高 revision。`cleanup()` 已豁免 `device_reply.*` staging（等 APK 期间 SHA 不能变）。file 限频 `LOCAL_AUDIO_FILE_RPM`（生产 120/60s/SN）按「候选文件数 ×1.5」对账，别按槽×5 估。
