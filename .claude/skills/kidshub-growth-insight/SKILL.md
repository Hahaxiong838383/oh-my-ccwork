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
3. P0–P3 交付与 Air 真数据库验收：代码仓 `docs/p0-p3-delivery.md`
4. P0–P3 复盘：代码仓 `docs/p0-p3-retrospective.md`
5. 用户配置清单：代码仓 `docs/user-configuration-checklist.md`
6. Provider 真实结果复盘：代码仓 `docs/provider-results-retrospective.md`
7. 三引擎扩量与风控复盘：代码仓 `docs/research-scale-retrospective.md`
8. 后续清单：`docs/next-todos.md`
9. Studio 实际代码：公司外 `ssh studio-pub`（经 `mini-pub` 跳板），公司有线局域网 `ssh studio` → `/Users/fu-121/kidshub-growth/app`

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

失败时停止，不准直连兜底。push 后检查 `~/xray/access.log` 的 `github.com:443 [socks -> DMIT-Gemini-vps-chenchuan]`。

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
ssh studio-pub 'cd /Users/fu-121/kidshub-growth/app && pnpm build'
ssh studio-pub 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-schema'
ssh studio-pub 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-m2'
ssh studio-pub 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-day7'
ssh studio-pub 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-m3'
ssh studio-pub 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-m4'
ssh studio-pub 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-m5'
ssh studio-pub 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-m55'
ssh studio-pub 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-mediacrawler-runtime'
ssh studio-pub 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-provider-runs'
ssh studio-pub 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-provider-results'
ssh studio-pub 'cd /Users/fu-121/kidshub-growth/app && pnpm ops:verify-ui'
ssh studio-pub 'launchctl print gui/$(id -u)/cn.kidshub.insight.web'
ssh studio-pub 'lsof -nP -iTCP:3200 -sTCP:LISTEN'
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
- P0：MediaCrawler 任务心跳/进程检查、二维码过期、僵尸任务收敛、安全重试、脱敏日志、评论/达人详情、数据质量提示和 90 天留存机制已完成；川哥确认能看到采集结果
- P1–P3：川哥已体验确认通过；全量正负向回归、生产构建、迁移、健康检查和双公网节点访问通过
- V2.1：营销 Rolling 看板已上线，支持月度/周期/单次投入、三层预期、七维过线、停损线、历史累计与 Rolling 决策
- V2.2：央视频《中国首发》200 万元预算计划、付款门禁、12 项指标、T+90 行动台账和四级预算推演已上线；模拟金额不计入真实支出
- V2.2 体验修复：周期已默认选中时，历史台账与当前周期入口仍会显式滚动并聚焦详情；桌面与 390px 手机端已由真实浏览器验证
- 当前正式用户只有 `rayman.chen@futurus.co` root
- 首批正式主数据已建立：读写台、爱视可、耐德佳、安目佳、京东方、20 条新增双平台关键词、6 个京东商品候选和 4 个研究计划
- 当前 MediaCrawler、规则引擎和火山方舟 `deepseek-v4-pro` 已启用；首个真实 `content_ideas` 任务成功
- QNAP 已通过 SSH/SCP 接收加密迁移包；远端 SHA-256、从 NAS 下载后的解密 dry-run 恢复和每日 03:15 launchd 调度均通过
- 首页已直接展示 MediaCrawler、TikHub、JustOneAPI 三套引擎、唯一入库进度、最近任务和直接入口
- TikHub 已扩量至 112 条唯一内容；JustOneAPI 已扩量至 102 条唯一商品评论；京东评论接口仍有单接口上游波动
- MediaCrawler 当前 58 条唯一内容；重新登录/风控下线后川哥决定暂停，取消任务已收敛且活跃 runner 为 0，未获新指令不得自动恢复
- 跨来源覆盖、评论情绪推断、痛点主题、来源表现、三引擎综合研究和版本化 Prompt 已完成；最终分析套件等待下一步运行
- UI 已升级为 Attio-inspired 浅色工作台；移动端 CDP 实测 `innerWidth=390`、`scrollWidth=390`
- M5.6 正式业务提交：`0f965dae2b7ba6ad8f470c2209606adf04ac23af`
- P0–P3 自主功能闭环提交：`bdd09767587584b0c7518571525f8f4feb51fd1e`；复盘提交：`307404b269990b7f0087ac47ff70ca3959161d52`；GitHub `main`、Air 与 Studio 当前对齐后者
- 下一步按 `docs/next-todos.md`：先用现有 58/112/102 条样本运行完整分析，再人工复核和校准 Prompt；MediaCrawler 保持暂停

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
- 持久任务状态不能只信数据库枚举；必须联合 PID 存活、心跳、超时和启动时收敛处理僵尸任务。
- 扫码流程必须记录二维码生成/过期时间；过期资源返回 HTTP 410，页面给出重新扫码入口。
- Runner 日志只展示有长度上限的脱敏摘要；Cookie、Token、完整环境变量和第三方错误对象不得进入页面、日志或审计。
- 留存清理默认 dry-run，只有显式 `--apply` 才允许删除；先展示任务数、文件数和字节数。
- Air 上执行 Prisma validate/build 时若没有项目 `.env`，显式传无敏感信息的占位 `DATABASE_URL`；缺少该变量先归因测试参数，不归因 schema 损坏。
- Fetch `Response` body 只能消费一次；二进制导出成功路径直接读 `arrayBuffer()`，只在非 200 时读取错误文本。
- 验收子进程必须显式覆盖或清除 `KIDSHUB_ROOT_DIR`、`KIDSHUB_DATA_DIR`、`DATABASE_URL` 等外部环境，避免把生产/上层路径带入隔离测试。
- `ops:verify-m55` 要求应用进程与验收器使用一致的 mock、导入来源和数据目录；不一致属于测试参数错误，不是业务导入失败。
- 37 张表是业务表口径；PostgreSQL `public` 下还包含 `_prisma_migrations`，完整 `pg_tables` 计数为 38。
- 加密备份先校验口令文件 600 和 OpenSSL，再生成归档；失败必须删除明文与半成品。备份目录 700，归档和 `.sha256` 600，不能接受默认 644。
- `ops:backup` 配置 `KIDSHUB_BACKUP_PASSPHRASE_FILE` 后自动加密；launchd 定时任务必须先加载项目 `.env`，否则 tsx 脚本拿不到 `DATABASE_URL` 和路径配置。
- LLM Provider 已配置密钥后，修改类型、Base URL、模型或鉴权方式必须先移除密钥；校验失败转 error，只能通过成功重验恢复。
- LLM `input_hash` 要包含 Provider 与 Base URL；单进程内并发相同任务共享在途调用，只有真正发出的请求记录 Token 和成本。
- 公司外访问 Studio 时先查 `~/.ssh/config` 和共享记忆；`studio-pub` 通过 `mini-pub` 跳板可达，不能因 `ssh studio` 局域网地址超时就判定公网运维入口不存在。
- shell 负向验收本身也要失败关闭：zsh 的 `status` 是只读变量，且仅执行 `grep` 后继续 `echo matched` 会产生假阳性；必须显式检查退出码和目标错误文本。
- zsh 默认不会把包含多组 `KEY=value` 的普通标量按空格拆词；隔离应用与验收器必须逐项传 `env KEY=value`，不能把整组环境变量塞进一个字符串。
- Playwright CLI 的 `run-code` 会回显完整代码；禁止把密码、Token 或 Session 插入代码字符串。优先使用现有登录态、非回显输入或一次性账号，并在结束后复核用户、Session、登录尝试和审计记录归零。
- `finally` 不能覆盖进程被强制终止的场景；全量验收结束必须扫描 `m2/day7/m3/m4/m5/m55/p13/ui-preview` 标识、临时端口和 `/tmp` 目录。发现残留先确认 source 和业务关联，再事务化精确清理。
- 完成声明必须同时对齐本地 SHA、GitHub remote SHA、Studio SHA、Studio dirty=0、正式端口、launchd、跨公网 HTTP 和测试残留；任何单项成功都不能替代整体闭环。
- OpenAI-compatible Base URL 可能已包含 `/v2`、`/v3` 等版本路径；不能固定追加 `/v1`。模型别名未出现在 `/models` 时，允许用最小 Chat 请求做真实校验。
- macOS `mount_smbfs` 的密码提示不一定能由 expect 接管；禁止因此把密码塞进 URL/参数。QNAP 可改用 `SSH_ASKPASS_REQUIRE=force` + 600 密码文件的 SSH/SCP 路径。
- 迁移验证器必须显式清除生产 QNAP 环境变量，否则隔离测试可能把假 dump 上传到真实 NAS；新增输出字段时保留既有 CLI 状态契约。
- zsh 的 `options`、`status` 等是特殊参数，脚本变量命名不得复用；构建与独立 `tsc` 不能并行争用 `.next/types`。
- Secret 脱敏不能依赖“长度至少 24”之类猜测；应先按字段标签识别整段值，再对任意长度、尾部 `=` 和标点做全值替换。任何漏入工具输出的 Token 都按泄露处理，不得继续写入生产。
- Provider HTTP 200 不是业务成功；必须继续校验业务 `code`、目标数组和有效条数。
- 对完整 JSON 使用宽泛 `token=` 正则会误吞公开 trace 并破坏响应；只替换运行时真实密钥及其 URL 编码值，同时验证 JSON 可解析。
- Raw Snapshot 只是证据层；可用闭环还需要规范化预览、幂等 upsert、日指标、`entity_aliases`、研究计划关联和详情 UI。
- 多平台 Provider 的外部实体 ID 必须带 `xiaohongshu:`、`jd:`、`tmall:` 等平台命名空间，避免跨平台碰撞。
- Provider 重复导入不能覆盖人工归属；未匹配品牌时保留已有 `brandId`，不得用空值清除。
- Provider 结果验收必须走公网登录态页面和导入动作，不能只看构建、HTTP 200 或数据库计数。
- 批量采集的完成度必须按规范化主表唯一记录数计算；单次响应 20 条不代表新增 20 条，跨关键词重复会被幂等键去除。
- 平台重新登录或风控下线时，账号安全优先于数量目标；不得绕过风控、自动连续重试或为了凑数扩大并发。
- MediaCrawler 批处理必须把 `QR_REQUIRED` 视为可恢复的人工卡点；二维码过期后安全取消，并同时验证数据库状态、runner PID 和系统进程归零。
- 首页采集卡片展示唯一内容/评论、可用状态和最近任务，不展示容易误导的 Raw Snapshot 数或供应商原始数组长度。
- 列表/卡片进入页面内详情时，不能把 `setSelectedId` 当成完整导航；当前条目已选中时 React 状态可能不变，必须仍提供滚动、聚焦、展开或路由变化等可见反馈。
- 页面内详情验收必须从真实入口点击，量化检查点击前后 `scrollY`、目标 `getBoundingClientRect()`、`activeElement`，并在 390px 验证无横向溢出；“DOM 中存在详情”不是用户可达证据。
- Playwright 自动化必须使用任务专属命名会话，避免默认会话被其他任务切页；凭据不得进入 `fill`/`run-code` 回显，结束后清理临时用户、Session、登录记录、审计和 storage state。
- launchd 日志路径先完整读取对应 plist；本项目错误日志真值是 `/Users/fu-121/kidshub-growth/logs/web.err.log`，禁止凭习惯猜成 `web.error.log`。
- Air 本地执行前先核对 Node/pnpm/项目二进制版本；默认 pnpm 与 `packageManager` 不一致时，不能把版本错误当成验证器失败，可使用已安装的 `./node_modules/.bin/*` 完成本地检查，正式证据以 Studio 锁定版本为准。
