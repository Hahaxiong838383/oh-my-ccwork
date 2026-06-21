# 18 · KidsHub-AI 体验台 → Android demo APK 方案（2026-06-19）

> team 调研（grok-4.3 + codex/gpt-5.5 + gemini/antigravity）+ cc 自验线上/官方文档收敛。
> 配套记忆：`project_p003_android_apk`。接手分支前先读本文 + `p003-deploy-ops` skill。

## 目标（川哥拍板，已收窄）
- **只做 kidshub-AI「体验台」** 面向孩子的小可对话能力 → 一个能装安卓机的 **demo APK**。
- 不做家长端小程序。形态 = 原生/跨端壳 + **云端小可 Agent（复用现有后端，不端侧重写）**。
- **demo 纯测试阶段**：儿童隐私合规先不管、不录音、不训练模型、保留信息与现有 kidshub-AI 一致。
- 第一优先级 = 最快跑通能点的 demo APK。

## 现状事实（cc 自验，2026-06-19）
| 项 | 实况【已验证】 |
|---|---|
| 体验台代码 | `apps/web`，React 18.3 + Vite 5 + Tailwind，入口 `apps/web/src/kidshub/StudioPage.tsx` |
| 公网地址 | `kidshub-ai.hahaxiong.cc`（+CF `kidshub.chenchuan.cc`），curl HTTP 200 / 0.26s，部署 aliyun-hk |
| **已是完整 PWA** | 线上 `manifest.webmanifest` 200、`registerSW` autoUpdate、icon-192/512/**512-maskable** 齐全、`display:standalone` + `orientation:portrait` |
| 语音架构 | 前端连 `wss://{window.location.host}/ws/voice`（`VoiceButton.tsx` 已处理 mixed content），后端 pm2 `p003-voice` + node:sqlite，已有 GEMINI_API_KEY |
| manifest 内容 | name「K1 生态缸」/ short_name「K1」/ start_url `/` / scope `/` / theme `#0a1929` |

## 结论：最快路 = Bubblewrap (TWA) 套现成 PWA

体验台**已满足 Bubblewrap 全部前置条件**（公网 HTTPS + manifest + SW + maskable icon），所以：
- **不需要 RN / Flutter / Compose 重写，也不需要先起原生壳**。
- ws 用相对 host，套壳后 WebView 里 host 仍是本域名 → **wss 语音零改动**。
- 工期：从初版调研估的「6–14 人周」塌缩到 **半天～1 天**。

> 语境说明：上一轮调研结论是「别用 WebView 做长期主 App」，前提是"长期/合规/体验"。本轮是"纯 demo 最快"，语境变了，TWA 套壳是对的。后续若转正式产品再评估 RN（现有是 React 栈，RN 复用率最高）。

## 落地步骤（Path A · Bubblewrap，接手即可执行）
```bash
# 0. 前置：JDK 17 + Android SDK（bubblewrap doctor 会引导装；或用下方 Path B 的官方 Android CLI 管 SDK）
npm i -g @bubblewrap/cli
bubblewrap doctor

# 1. 用线上 manifest 初始化（packageId 建议 cc.hahaxiong.kidshub）
bubblewrap init --manifest https://kidshub-ai.hahaxiong.cc/manifest.webmanifest
#    交互里设：Application name / packageId / 签名 key（demo 用自动生成的 debug/release key 均可）

# 2. 构建
bubblewrap build        # 产出 app-release-signed.apk + app-release-bundle.aab

# 3. 装真机实测
adb install app-release-signed.apk      # 或直接把 apk 传手机安装
```

## ⚠️ 接手必须真机实测的两个点（cc 未拍胸脯，标待验证）
1. **TWA 麦克风权限**【待验证·阻断级】：语音要 `getUserMedia`，TWA 走手机 Chrome 内核，需 APK 声明 `RECORD_AUDIO` + 运行时授权。能否顺利录音，**必须真机点一次**才知道。这是 demo 唯一可能卡死的地方。
   - 若 TWA 录不到音：退到 Path B（Android CLI 起 Compose WebView 壳，原生申请麦克风权限注入 WebView）。
2. **去掉顶部地址栏**【可选·非阻断】：TWA 全屏无浏览器条需在站点放 `/.well-known/assetlinks.json` 关联 APK 签名 SHA256 指纹。不放也能装能用，只是顶部一条 Chrome 地址栏（demo 可接受）。

## 备选路（Path B · 官方 Android CLI，体验/权限可控）
- **Google 官方 Android CLI**（`developer.android.com/tools/agents/android-cli`，2026-04-16 发布，agent-first，**显式支持 Claude Code 当 driver**，macOS GA）：
  `android create` 起 Jetpack Compose 骨架 → Compose WebView 嵌 `kidshub-ai.hahaxiong.cc` + 原生授麦克风权限 → `android run` 部署 → 出 APK。
- 适用：TWA 麦克风踩坑、或要更可控的原生权限/全屏体验时升级。

## 不要踩的坑（team 调研中 cc 验证纠偏的外部引擎错误）
- ❌ **别用 Firebase Studio / Project IDX**：IDX 已于 2025-04-15 改名 Firebase Studio；Google 2026-03-19 宣布 sunset，**2026-06-22 起禁止新建 workspace/注册**，2027-03 关停。gemini 推荐它，过时。
- ❌ **Gemini Live API 是 WebSocket 不是 WebRTC**（官方 `ai.google.dev/gemini-api/docs/live-api`）。若 demo 后续想上低延迟实时语音可评估它（小可后端已有 GEMINI_API_KEY），但接的时候别按 WebRTC 写。
- ✅ **Google 确有官方 Android CLI**（grok/codex 两家都误判"没有"，被 cc 官方文档一手验证纠正——外部引擎输出只能当待验证假设）。

## 团队调研依据（来源）
- 跨端框架对比：`/tmp/r-grok.md`（推 RN+Expo）、`/tmp/r-gpt.md`（推 Flutter+WebView）、grok/codex 共识=别纯 WebView 做长期主 App。
- Google 自家视角：`/tmp/r-gem2.md`（antigravity gemini-3.5-flash，提出 Bubblewrap/Gemini Live/IDX）。
- 官方一手：developer.android.com（Android CLI）、ai.google.dev（Gemini Live API）、firebase.com + Wikipedia（Firebase Studio 关停）、GoogleChromeLabs/bubblewrap。

署名：cc（Claude）| 2026-06-19
