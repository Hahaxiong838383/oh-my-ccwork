# D1 进度日志 · 2026-05-13 ~ 14（约 2 小时极速冲刺）

> 实际只用了夜间 2 小时（22:00 → 00:12）完成了 V0.1 → V0.4 共 4 版迭代 + 主界面框架 + 4 把 key 实测 + 凭据脱敏全套。
> 真正的"D1 链路日"明天继续，今晚先收主界面框架。

---

## 时间轴

| 时间 | 阶段 | 关键动作 |
|---|---|---|
| 22:03 | V0.1 | 创建项目目录，搭脚手架（手机竖屏 PWA + PixiJS） |
| 22:13 | V0.2 | 读完[K1 框架文档](https://futurus.feishu.cn/wiki/PFELwNaTmi5CXskD2PDc5lfWncb)，对齐 800×480 横屏 + Mock Server |
| 22:43 | V0.3 | 读完[首批 12 文档](https://futurus.feishu.cn/wiki/Qyfgw1PIiimx7kkP6nycota6nwh)，9 张配置表 + 9 层 LayerManager + XState 4 机器 |
| 22:58 | V0.3 | 读完[第三批 15 文档](https://futurus.feishu.cn/wiki/J71cwDHgwi86FSkrF2hcWpodn3b)，加扩展钩子（personality / scene plugin / 抽卡共用容器） |
| 23:08 | **V0.4** | **川哥定 4 个绝对目标**：800×480 / AI 实时语音 / 4 天 / demo 第一 → 锚定 DEMO-PRINCIPLES.md |
| 23:14 | 调研 | codex (gpt-5.3-codex/high) + gemini-3-flash 双路调研，火山三段方案 + gemini 评审 |
| 23:20 | 整改 | 川哥提醒脱敏 → 凭据管理铁律建立（.env.local + chmod 600 + gitignored） |
| 23:23-50 | 实测 | 4 把 key 实测：讯飞 11200 / Gemini 代理 ✅ / MiniMax 2.7 reasoning / TokenPlan endpoint 错猜教训 |
| 23:53 | 开干 | 川哥确认 V0.4 框架开干（cc 主线 + codex 并行 + gemini 评审） |
| 00:01 | 交付 | codex 实现 9 组件 145K tokens / 7 分钟 / vite build 一次过 |
| 00:06 | 调整 | 强制横屏 CSS rotate(90deg)（iOS API 锁不了横屏） |
| 00:10 | 调整 | VoiceButton 移出屏幕画布到外壳下沿条（不污染游戏主界面） |

---

## 完成清单 ✅

### 文档
- [x] [DEMO-PRINCIPLES.md](DEMO-PRINCIPLES.md) 4 绝对目标 + 复盘清单
- [x] [00-product-spec.md](00-product-spec.md) 产品规格（V0.3 完整版）
- [x] [01-tech-architecture.md](01-tech-architecture.md) 技术架构（V0.3 完整版）
- [x] [02-roadmap.md](02-roadmap.md) V1.0 完整 roadmap
- [x] [03-state-machine.md](03-state-machine.md) XState 详图
- [x] [04-config-tables.md](04-config-tables.md) 9 张配置表索引
- [x] [05-server-contracts.md](05-server-contracts.md) C/S 接口契约
- [x] [06-evolution-roadmap.md](06-evolution-roadmap.md) V1.0-V1.70 版本演进
- [x] [07-v04-implementation-plan.md](07-v04-implementation-plan.md) V0.4 4 天实施计划

### 前端 V0.4 主界面框架
- [x] 设备外壳 DeviceFrame（800×480 5:3 + LED + 麦克风孔 + 电源键 + 强制横屏 + 下沿条 VoiceButton）
- [x] 9 个组件（components/）：
  - EcoBackground、Xiaoke、CoinHud、StatusBar、FocusToggle、VoiceButton、WizardOfOz、MainScreen、ShutdownScreen
- [x] 单一 Zustand store（store/app-store.ts）
- [x] 通用 Tips 队列 + ConfirmModal + NewbieHalo（V0.3 复用）
- [x] CSS 强制横屏 rotate(90deg) for portrait
- [x] vite build 通过（gzip 90KB）
- [x] tsc --noEmit 0 错误
- [x] dev server 跑通，手机扫码可访问

### 后端骨架
- [x] apps/server/ 目录骨架（src/ + scripts/）
- [x] .env.example（4 大供应商占位）
- [x] .env.local（4 把 key 入位，chmod 600 + gitignored）
- [x] 4 个诊断脚本（xfyun / gemini / tokenplan / minimax-tts）

### 供应商凭据 4 把
- [x] 火山引擎：⏸ 待开通
- [x] 讯飞 TTS：✅ 入位 / ⚠️ 11200 LiccCheck（控制台领试用包）
- [x] Gemini 代理：✅ 入位 / ✅ chat 可用 TTFT 1024ms
- [x] MiniMax 2.7：✅ 入位 / ⚠️ TTS 套餐 0/0（需加购）

---

## 后续 TODO

### D2 · 声画日（最痛苦的一天）—— 川哥开通权限后

#### 川哥需要先开通的资源（D2 启动前必须就位）
- [ ] **火山引擎账号**实名 + 开通：
  - [ ] 流式 ASR（doc 6561/80818）
  - [ ] 火山方舟豆包 Chat（拿 API Key + Endpoint ID）
  - [ ] TTS v3 双向流式（doc 6561/79821）
- [ ] **MiniMax 加购 T2A 配额**（如果想用 MiniMax TTS 备选）
- [ ] **讯飞控制台**领取 x6 音色试用包（如果想用讯飞 TTS）
- [ ] **本地装 Bun**：`curl -fsSL https://bun.sh/install | bash`
- [ ] **确认云端部署目标**：阿里云 VPS / Vercel / Cloudflare（D4 上云用）

#### cc 任务
- [ ] 后端 apps/server/src/index.ts （Hono + ws 入口）
- [ ] providers/volc-asr.ts WebSocket 客户端
- [ ] providers/doubao-llm.ts 流式 chat（结构化 emotion/action 输出）
- [ ] providers/volc-tts.ts v3 双向流
- [ ] pipeline.ts 三段协调器（含打断）
- [ ] CLI 脚本端到端串通："输入文字 → 听到 TTS 出声"
- [ ] 前端 voice-client.ts：getUserMedia + AudioWorklet PCM16
- [ ] WebSocket 端点 /ws/voice 接通前端
- [ ] **D2 下午 4 点止损点**：如果声画对不上，立即切短轮询版本

### D3 · 拼图日（造假大师）
- [ ] 延迟掩盖术（用户松开按钮立即播本地"嗯..."过渡到真回答）
- [ ] 状态指示精修（小可正在听/想/说）
- [ ] FocusToggle 接真奖励 API（mock server 或写死）
- [ ] WizardOfOz 升级：键 1/2/3 = 真业务命令而不是仅模拟字幕

### D4 · 演出日
- [ ] 后端部署到云端（同地域机房）
- [ ] HTTPS + 域名/IP 接入
- [ ] 手机扫码真机测试（iOS Safari + Android Chrome）
- [ ] 3 条必通对话路径排练
- [ ] 录 90s demo 视频

---

## 待川哥提供的资源

- [ ] **小可视觉资源**（PNG/雪碧图/Lottie），川哥说会另发或放 GitHub 代码仓
  - 小可机器人正脸（待机 + 5 种情绪：happy/curious/warm/calm/excited）
  - 至少 3-4 帧待机循环动画
- [ ] **生态缸背景图**（800×480 横版，可选）
- [ ] **音色定型**：讯飞 x6 系列哪个最适合小可 IP（lingxiaoxuan_pro vs xiaonaigoudidi_mini vs dongmanshaonv_pro）

---

## 经验教训（已沉淀到 memory）

1. `feedback_demo_scope_anchor_doc.md` — 短工期 demo 必写 DEMO-PRINCIPLES 锚定
2. `feedback_credential_test_script_rule.md` — 凭据测试脚本铁律
3. `feedback_provider_probe_check_memory_first.md` — 测 API 前先 grep memory
4. `feedback_codex_team_with_contract.md` — codex prompt 含接口契约
5. `reference_p003_ai_voice_providers.md` — 4 家 API 实测对比

---

## 关键交付物

- **GitHub**: `私有主仓` · `2-Projects/P003GameDemo20260513/`
- **当前 commit**: `c3f55ff4`
- **本地访问**: `http://localhost:5173/`（dev server 已关，下次 `cd apps/web && npx vite --host`）
- **手机扫码**: 同 WiFi (iBRO) 访问 `http://<内网IP>:5173/`
