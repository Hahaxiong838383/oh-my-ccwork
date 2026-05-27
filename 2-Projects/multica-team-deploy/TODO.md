# TODO — multica-team-deploy

> **基线日期**：2026-05-27 22:40 完成飞书集成全链路 + ONBOARDING
> **当前状态**：multica + 飞书 OAuth side-car + oauth-ui + skill ↔ agent ↔ lark-cli 端到端实测通过。明天去公司发邀请给团队。
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

---

## 🟥 P0 · 明天去公司（一鼓作气）

- [ ] **P0-2 拉 2-3 个内测成员**
  - 发 ONBOARDING.md
  - 各扫码绑定飞书
  - 各派 1-2 个真任务（发消息 / 创建文档 / 读 wiki）
  - 验证多用户隔离不打架（同时 2 人并发授权 + 派任务）
- [ ] **P0-3 收集首批反馈**
  - 哪一步 confusing
  - oauth-ui 自动检测命中率
  - 哪种任务描述 agent 易理解 / 易误解

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
