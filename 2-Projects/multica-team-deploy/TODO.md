# TODO — multica-team-deploy

> **基线日期**：2026-05-28 18:36 Gemma 4 E4B v2.5 真实能力解锁 + 双 grok coordinator 配置 + runtime 三连修 + 内测前 P0-A/P0-B 完成
> **当前状态**：5 runtime 全 online + 8 active agent 配置就绪 (含 Gemma v2.5 / 爱马仕grok 快速+4.3 / 飞书代理 V3 + HR squad 4 个) + 4 邮箱白名单生效。等 Resend 切真邮件。
> **优先级标记**：🟥 P0 阻塞 / 🟧 P1 重要 / 🟦 P2 扩展 / 🟪 P3 长期 / 🟫 P4 加固

---

## ✅ 已完成（今日 + 历史）

### 基础设施（上一周期）
- [x] QNAP TS-X65 server (multica + postgres + redis)
- [x] Mini M4 daemon (3 runtime: claude + codex + gemini)
- [x] HK 8.218.26.17 nginx relay (https://multica.cli4.hahaxiong.cc, LE 证书)
- [x] FRP cli4.hahaxiong.cc:7000 + Mini frpc launchd
- [x] xray 路由（GPT/Claude → 美宅, Gemini → Gemini 专用）
- [x] codex 0.134 via cc-switch proxy via LXJ
- [x] WS 400 修复（nginx location 移到正确 server block）
- [x] QNAP daily backup cron + 5min rollup cron

### 飞书集成（今日 2026-05-27）
- [x] **Phase A** 二 runtime 验证（gemini 挂起）
- [x] **Phase B** lark-cli 升级 v1.0.41 + 19 lark-* skills 同步到 mini
- [x] **Phase C** Device Flow PoC 5 脚本 (01-05)
- [x] **Phase D** multica HR squad agent ↔ 飞书 PoC（端到端真发飞书消息）
- [x] **P0 sidecar** Go 服务 (590 行 + 14 测试 + launchd KeepAlive)
- [x] **A 集成** skill 飞书代理操作-zh V2 + agent 飞书代理操作员 + issue.metadata.feishu_user_id
- [x] **A.V2** wrapper PATH bug + skill 错误分类 3.1-3.5 + retry max 2 + 铁律 #4
- [x] **B oauth-ui** HTML 单页 (351 行) + nginx /oauth-ui + /api/feishu/ 反代 + FRP 18890→18090
- [x] **04 v3** 真根因 (watch token enc + mkdir lock + LARK_BIN 绝对路径 + jq nested)
- [x] **sidecar self-heal** statusHandler mapping 缺时自动重建
- [x] **P0-1a** oauth-ui 同域 fetch /api/me 自动检测
- [x] **P0-1b** ONBOARDING.md 团队 3 步上手文档
- [x] **飞书文档读写实测** FUT-18 docx (`WkhZdwfLfo4zCexYKetc46ldnMz`)
- [x] **RETRO-2026-05-27.md** 收工复盘（16 commit / 13 memory / 13 踩坑 / 6 经验范式）

### Runtime 加固（2026-05-28）
- [x] **Gemma 4 E4B Studio 部署** — Studio Ollama + Mini ↔ Studio Thunderbolt bridge 192.168.100.x 固定 IP + SSH tunnel 11434 launchd
- [x] **gemma-direct adapter v2.2** — opencode runtime hijack 跑 Gemma 4 E4B，FUT-20 vs FUT-32/33 实测 11m5s → 20-32s（20-33x 提速）
- [x] **hermes runtime 修复** — daemon plist 加 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY/NO_PROXY 走 xray mixed (127.0.0.1:10808)，FUT-34 grok-4.20 26s 完成
- [x] **codex runtime 修复** — 删 `~/.codex/config.toml` 末尾遗留 `[model_providers.ollama]` wire_api="chat" block，FUT-35 codex-5.5 90s 完成
- [x] **RETRO-2026-05-28-runtime-fixes.md** 三连修复盘

### Agent 体系完整化 (2026-05-28 下午+傍晚)
- [x] **archived agent name 释放** SQL 给 4 个 archived agent 加 [archived-<date>] 后缀腾 name slot,避免 23505
- [x] **爱马仕grok（快速）coordinator** 灌入 v2 instructions (0 号铁律 + 派单流程 + 4.3 agent id 硬编码),FUT-39 端到端验证派子 issue 成功
- [x] **爱马仕grok（4.3）deep worker** 灌入 RPT 五步范式 instructions
- [x] **gemma-direct adapter v2.4** 拉 multica agent get → 注入 Ollama system message,multica web 改 instructions 即时生效
- [x] **gemma-direct adapter v2.5** ★ 修 num_ctx=2048 隐藏 bug (Ollama 默认 2K, Gemma 4 支持 128K) — 切 /api/chat 原生 NDJSON + options.num_ctx=32K
- [x] **Gemma 4 E4B agent v2 instructions** 基于官方模型卡 + benchmark 重写 (强项/中等限制/真不能三档),thinking mode 引导
- [x] **5 维度能力实测** FUT-43~47: 中等推理 + 结构化 JSON + 代码 LRU+TTL + 长输入摘要 + 应 refuse 全部 ✅

---

## 🟥 P0 · 明天去公司（一鼓作气）

> **2026-05-27 晚发现 2 个挂起问题,详见 [ISSUES-TRIAGE-2026-05-27.md](./ISSUES-TRIAGE-2026-05-27.md)**

### P0-A 邮件邀请收不到（阻塞内测开始）
- [x] **P0-A1**: 川哥给内测成员邮箱清单(2026-05-28: xinrun.li / rayman.chen / ping.yang @futurus.co)
- [x] **P0-A2**: cc 改 QNAP `.env` `ALLOWED_EMAILS=...` + ~~docker restart~~ → `docker compose up -d backend`(restart 不 reload env 踩坑,详见 RETRO 2026-05-28)
- [x] **P0-A3**: ONBOARDING.md Step 1 列 4 白名单邮箱 + 验证码 888888 提示
- [ ] **P0-A4**: 川哥注册 Resend 拿 API key
- [ ] **P0-A5**: cc 切 production mode + 配 RESEND_API_KEY + 实测发邮件(30 min)

### P0-B issue 隔离心智沟通
- [ ] **P0-B1**: 明天上午跟内测成员说明"workspace 内 issue 默认互看"心智
- [ ] **P0-B2**: 决策：所有内测共用 1 workspace（默认透明）vs 按业务分 2-3 workspace

### P0-C 内测拉人 + 实测
- [ ] **P0-C1**: 拉 2-3 个内测成员（先 P0-A 解了再拉）
- [ ] **P0-C2**: 各扫码绑定飞书 + 各派 1-2 个真任务（发消息 / 创建文档 / 读 wiki）
- [ ] **P0-C3**: 验证多用户并发授权不打架（同时 2 人扫码）
- [ ] **P0-C4**: 收集首批反馈（confusing 点 / 自动检测命中率 / 任务描述误解）

---

## 🟧 P1 · 本周加固

- [ ] **修 handlers_test.go**（30 min）
  - self-heal 加入后旧 test `no_mapping_but_home_exists` fail
  - 加 self-heal happy path 测试
  - go test 必须 100% green
- [ ] **token 过期主动通知**（半天）
  - sidecar 加 cron 每天扫所有 mapping
  - 距 `refreshExpiresAt < 24h` 用 lark-cli 给本人发飞书消息 "请重新扫码授权"
- [ ] **sidecar metrics endpoint** `/metrics`（2 hour）
  - prometheus format: 成功授权数 / 失败数 / token 过期数 / per-user 请求数
- [ ] **oauth-ui 完成态 polish**（1 hour）
  - 加"复制 multica_user_id"按钮
  - 加"3s 后自动关窗口"倒计时
  - 加"再绑定其他飞书账号"重置按钮（高级用户）
- [ ] **sidecar 启动时清理 stale lock_dir**（10 min）
  - 防 sidecar kill -9 后 lock_dir 残留导致下次 04 卡 30s
- [ ] **multica web 集成"飞书绑定"入口**（待决策）
  - 选项 A：bookmarklet（用户拖书签栏，1 键跳 oauth-ui）
  - 选项 B：tampermonkey user-script（强但需团队装扩展）
  - 选项 C：fork multica web 加官方按钮（最优雅但维护重）
  - 决策时机：内测 3-5 人有反馈后

---

## 🟦 P2 · HR squad 完整版（之前留的）

- [ ] **Input-Sanitizer agent** prompt injection / 隐藏指令 / unicode 异常扫描
- [ ] **Anonymizer agent** 简历去标识 V2（PII 自动识别）
- [ ] **Interview-Kit agent** JD + 简历生成面试问题
- [ ] **Communication-Draft agent** 拒信/录用通知自动起草
- [ ] **Match-Reviewer agent** 候选人匹配独立打分

---

## 🟪 P3 · 长期机制

- [ ] **JSON mapping → PostgreSQL**（>20 人或需 audit 时）
- [ ] **sidecar 容器化** docker + compose 跟 multica 一起部署
- [ ] **CI/CD 自动部署 sidecar** git push → deploy-mini.sh 自动跑
- [ ] **wechat / Slack / Discord 集成** 复用 sidecar + skill 范式
- [ ] **PR 上游 multica** "通用 OAuth sidecar 接入范式"benefits 全社区
- [ ] **multica daemon launchd plist** 当前手 `daemon start --foreground` 跑，做 plist 让 mac 重启自动起

---

## 🟫 P4 · 小坑

- [ ] **04 V3 lock_dir sharded** 当前 per-mapping-file mutex，>50 user 高并发要 per-user lock
- [ ] **oauth-ui 国际化** 当前纯中文 UI，看团队规模决定是否加英文
- [ ] **secrets rotation** multica PAT / FRP token / LXJ key 定期轮换
- [ ] **04 polling 进度上报** sidecar log 加 "polling started/token detected/exit gracefully" 让运维看到完整链路
- [ ] **修个别旧脚本 quoting** 派 codex 时偶尔出现 sed 命令 quoting 错误，文档教训
- [x] **gemma-direct 失败重试** v2.3 已加 3 次 retry + 5s/15s 退避 + Ollama 健康探测 (FUT-36 验证)
- [ ] **gemma-direct 真 streaming** 当前 batch 收完再 emit，multica web 看不到逐字流式，需调研 daemon stream-json 协议
- [ ] **gemma 多模态支持** adapter v2.5 已切原生 /api/chat,可加 messages[].images: [base64] 让 Gemma OCR/图表/PDF 能力发挥
- [ ] **gemma 思考模式 post-process** 当前 `<think>...</think>` 全发给用户,可在 adapter 端切片只发块外答案
- [ ] **gemma 128K full ctx 测试** 当前 32K, VRAM 占用 ~25GB; Studio 128GB 支持全开 128K (~50GB),需要测速度衰减
- [ ] **xAI proxy 凭据保护** xray 节点切换/失效后 hermes 直接挂，加 healthz 自检脚本
- [ ] **multica agent.skills 字段对 hijacked agent 不生效** 在 gemma-direct README 标说明,避免团队误以为配 skill 就生效

---

## ⚠️ 已知遗留风险

| 风险 | 影响 | 缓解状态 |
|------|------|---------|
| sidecar kill -9 → lock_dir 残留 | 下次 04 卡 30s 超时 | P1 加启动清理 |
| token 过期前 0 通知 | 用户突然发不出消息 | P1 加 cron 通知 |
| handlers_test.go 1 个 case fail | CI 不绿 | P1 修 |
| Gemini runtime 未认证 | 派给 gemini agent 必败 | 当前 agent 都绑 claude/codex，不影响 |
| sidecar 单点 | mini 停就全垮 | 单家庭内测可接受，生产化时上 HA |

---

## 📍 资产速查

| 资产 | URL / 路径 |
|------|------|
| multica web 入口 | https://multica.cli4.hahaxiong.cc |
| 飞书授权页 | https://multica.cli4.hahaxiong.cc/oauth-ui |
| sidecar healthz | https://multica.cli4.hahaxiong.cc/healthz |
| 上手文档 | https://github.com/Hahaxiong838383/mycc/blob/main/2-Projects/multica-team-deploy/ONBOARDING.md |
| 项目 RETRO | https://github.com/Hahaxiong838383/mycc/blob/main/2-Projects/multica-team-deploy/RETRO-2026-05-27.md |
| sidecar 日志 | mini `~/Library/Logs/feishu-oauth-sidecar.log` |
| sidecar mapping | mini `~/multica-user-homes/user_mapping.json` |
| 用户 HOMEs | mini `~/multica-user-homes/mc-user-<id>/` |
| 5 PoC 脚本 | mini `~/lark_multi_user/*.sh` |
