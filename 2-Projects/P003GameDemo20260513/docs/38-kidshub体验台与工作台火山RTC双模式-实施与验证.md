# 38 · KidsHub 体验台与工作台火山 RTC 双模式 — 实施与验证

> 2026-06-22。前置：docs/35（手机端火山 RTC 集成）。配套记忆 `feedback_p003_workbench_volc_rtc_dual_mode`。
> 一句话：把手机端跑通的火山 RTC 全双工，扩到 web 端的「体验台独立页」+「工作台本体双模式」，核心技术 = **prompt override 绕开火山中途换 prompt 限制**。

## 背景

手机端小可 app 火山 RTC 全双工体验好（自然对话、可打断、低延迟），川哥要 web 端也具备。web 端有两个对象：
- **体验台 `/kidshub-ai/live`**：给人体验小可对话（简洁全双工）
- **工作台 `/kidshub-ai`（StudioPage）**：内测在用，给运营/PM 调 prompt 测小可

## 两阶段交付

### 阶段一：`/kidshub-ai/live` 独立 RTC 体验页
- 新增 `KidsHubLivePage`（桌面火山全双工），**复用**手机端 `useVolcRtc` + `MobileAvatar`，自写桌面布局 + 电影字幕 + 连接进度倒计时 + 吐槽 + autoplay 兜底
- `main.tsx` 加 `/kidshub-ai/live` 独立路由（**先判 isKidsHubLive 再判 isKidsHub**，否则 `/live` 也 startsWith `/kidshub-ai` 会进工作台）
- **server 零改动**（复用现成 `/api/rtc/start|stop|feedback-arm` + `/v1`）；**nginx 零改动**（`try_files … /index.html` SPA fallback 自动支持）
- 取舍：固定小可大脑（不调 prompt，川哥定）；表情按状态大类、字幕用火山整句（沿用手机端已上线方案）

### 阶段二：工作台 StudioPage 双模式（prompt override）

**核心矛盾**：工作台 = 「调 prompt 看效果」工具——选场景卡→组装 prompt 下发→逐句表情+电影字幕+调试流，**整套深绑 WS pipeline**；火山 RTC = 固定大脑黑盒，拿不到工作台调的 prompt，也拿不到逐句文本驱动表情/字幕。

**方案：双模式（并存，不替换）**——WS 调试台原样保留（内测不受影响），新增「实时对话」按钮切火山全双工。调试看 WS，体验切 RTC，互补。

**prompt override（绕开火山限制）**：
- `rtc-prompt-override.ts`：内存 `Map<roomId, {systemPrompt, expireTs}>` + TTL 2h（仿 `feedback-arm` 范式）
- `/start` 接收 body.systemPrompt → 存 override + custom-llm 回调 URL 带 `?session=roomId`
- `custom-llm` 按 `?session` 取 override 作 systemPrompt（取不到降级固定大脑，**向后兼容**手机端/live）；override 时跳过记忆/onboarding/召回（工作台 composed 自包含，不污染真实 profile）
- `/update-prompt` 热更（工作台改 prompt → 更 Map，**custom-llm 每轮取最新** → 下一句即生效，不重连）
- **关键洞察**：prompt 存在我方、custom-llm 每轮取最新，**绕开了火山进房后 SystemMessages 不可中途改的限制**——火山只管语音 I/O

**前端**：`CanvasHost` 控制条「按住说话」左边加「🎙 实时对话」按钮 + 「⟳ 应用新 Prompt」热更；rtcMode 下禁用 WS「按住说话/吐槽」实现**麦克风互斥**（进 RTC 先 bargeIn+停录音，退出 leaveRoom）；WS 模式默认保留。

**prompt 净化（`sanitizeForVolcRtc`）**：addendum 第 5 条「句级表情标记【表情：xxx】」对火山**有害**——WS 靠 server 剥离标记驱动 avatar，但 custom-llm 不剥离 → 火山直接 TTS 会把「表情吃惊」念出来污染语音。净化行级剔第 5 条 + 正/反例，末尾追加禁令兜底；第 6 条「不描述外观」等对 RTC 有效的保留。**仅工作台 RTC 触发时净化，WS/手机端/live 其他场景 prompt 一律不变**。

## 验证

- **override E2E**（决定性）：设「咪咪猫」override → 带 `?session` 调大脑答「喵喵喵」；不带 session → 「我是小可…」默认世界观。证明工作台 prompt 真生效 + 向后兼容。
- **净化 mini 测**：第 5 条/正反例删净，第 4/6/7/8 条（不描述外观、护眼红线、KidsHub 反馈）保留，正文零【表情标记残留。
- **真机测通过**：体验台 /live + 工作台「实时对话」+ prompt 生效 + 不念表情标记。
- **零影响验证**：`git diff` 实锤工作台共享文件无变更；工作台/手机端 `/m`/admin 全 200 不受影响；server 部署 `rsync -c` 实锤只 3 文件内容变化。

## 关键决策与取舍

| 维度 | 选择 | 理由 |
|---|---|---|
| 替换 vs 双模式 | **双模式** | 保留工作台调试价值（逐句表情/perf/引导旁白只在 WS 有）+ 不破坏内测 |
| 体验台 /live 大脑 | 固定大脑 | 川哥定「砍调 prompt」，纯体验 |
| 工作台 RTC 大脑 | prompt override | 保留「调 prompt」，override 让 RTC 用调的 prompt |
| RTC 模式降级（接受） | 表情→状态大类、字幕→火山整句、perf/引导旁白丢失 | 火山黑盒拿不到逐句文本/细粒度时点 |

## 部署（worktree 隔离实施，p003-deploy SOP）

- **server**：`rsync -c src` 只传 3 文件（rtc-prompt-override 新 + rtc/custom-llm 改）+ `pm2 restart`；向后兼容，零影响现有
- **web**：`rsync --delete --exclude admin` dist；工作台默认 WS 不变，加「实时对话」入口
- **回滚锚点**：每次部署前 `_backup/` 备份 dist（`mzrFQXOf` → `_k2IFTpA` → `DooqJyHZ` → `Bp_KD7B3`）
- **PWA SW**：`/live` 走不注册 SW 分支；工作台老用户首次访问可能需刷新一次
