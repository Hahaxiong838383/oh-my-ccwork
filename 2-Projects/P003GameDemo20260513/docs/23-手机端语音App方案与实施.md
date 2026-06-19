# 23 · 小可手机端语音 App —— 方案与实施（2026-06-19）

> 承接 `docs/18-android-demo-apk方案.md`（TWA 套壳初版），本轮按川哥 7 条需求升级为**原生壳 + Web 核心复用**完整方案并落地实现。
> team 四发（grok-4.3 + gpt-5.5 + gemini-3 + gemini-3.5）对抗 + cc 综合 + worktree 实施。
> 配套记忆：`project_p003_android_apk`（已更新）、`feedback_mobile_voice_app_native_shell_web_core`。

## 川哥的 7 条需求
1. 自适应手机分辨率 + 全屏使用
2. 语音对话需麦克风权限，自动申请
3. 复用现有 kidshub 体验台 web 端的邀请码登录
4. 进主界面后用「苹果简洁科技清新风格」设计 UI（taste skill）
5. 主界面复用小可形象，让它"站在屏幕主界面的空间里"
6. 唤醒词"小可小可"触发语音对话，也可按键触发；按键放界面下部便于大拇指按住
7. 对话显示字幕 + 小可状态（聆听/思考/说话），与现有 web 端类似

## team 四发核心结论：推翻 TWA 套壳
docs/18 的「Bubblewrap TWA 零改造套壳」被需求 6（唤醒词）这个新变量证伪。四家一致点出 TWA 4 硬伤：

| TWA 硬伤 | 后果 |
|---|---|
| Chrome 后台/锁屏挂起 Web Audio + WASM | 唤醒词在 TWA 里 100% 失效 |
| 权限双重弹窗（系统 + 网页） | 体验割裂，国产 ROM 拦截更严 |
| assetlinks.json 国内校验易失败 | 全屏退化、顶部网址栏 |
| 无法保活 | 常驻麦克风监听做不到 |

## 最终架构：原生薄壳 + Web 核心 + 唤醒分级
```
┌─────────────────────────────────────────────┐
│  原生 Android 薄壳 (Jetpack Compose)          │
│  ├─ 全屏沉浸 (setDecorFitsSystemWindows)      │
│  ├─ 麦克风权限托管 (onPermissionRequest 一次授权) │
│  ├─ 原生 Porcupine "小可小可" 前台唤醒          │
│  └─ JS Bridge (KidshubNative / KidshubWeb)    │
│       ↕                                       │
│  ┌──────────────────────────────────────┐    │
│  │  WebView 装 Web 核心（新建 /m 路由）    │    │
│  │  复用: voice-client / 邀请码登录 /      │    │
│  │       字幕 / 状态机 / 小可表情库        │    │
│  └──────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
       ↓ wss /ws/voice（后端零改动）
```

### 唤醒词分级决策（cc 一手判断）
team 一致警告「后台/锁屏常开唤醒在国内安卓 = 系统工程灾难」（ROM 强杀 + 童声识别率 <50% + Picovoice 海外激活 + 耗电）。
**cc 判断：孩子用 app 是前台盯屏场景，前台唤醒就够，后台唤醒非必需。**
→ 落地：**前台唤醒（原生 Porcupine）+ PTT 100% 可靠兜底；后台/锁屏唤醒 demo 不做。**

## 7 条需求落地状态

| # | 需求 | 落地 | 状态 |
|---|---|---|---|
| 1 | 自适应全屏 | `min-h-[100dvh]` + `env(safe-area-inset-*)` + 原生沉浸式 | ✅ Web 实现 |
| 2 | 麦克风自动申请 | 原生 `RECORD_AUDIO` + `onPermissionRequest` 透传，一次授权 | ✅ 原生实现，待真机 |
| 3 | 邀请码登录 | 复用 `POST /api/auth/invite` + `applyProfileToVariables`，苹果风重做 UI | ✅ 实现 |
| 4 | 苹果简洁科技清新 UI | taste skill：浅色渐变 + 毛玻璃 inner refraction + 单 accent sky + 纯 SVG（禁 emoji） | ✅ 实现 + preview 验收 |
| 5 | 小可站在空间里 | 复用 25 张 WebP 表情库 + avatar-store，移动端居中站位 + 光晕投影 + 呼吸 bob | ✅ 实现 + preview 验收 |
| 6 | 唤醒词 + 底部 PTT | 底部拇指区大圆 PTT（`touch-action:none`）+ 原生 Porcupine「小可小可」前台唤醒 → JS Bridge | ✅ PTT 实现；唤醒框架就绪待 key+真机 |
| 7 | 字幕 + 状态 | 复用 `app-store.subtitle/voiceStatus` 4 态 + 电影式 cue，移动端苹果风字幕 | ✅ 实现 |

## 实施成果

### Web 层（cc Solo，`apps/web/src/mobile/`）
| 文件 | 职责 |
|---|---|
| `bridge.ts` | JS Bridge 契约单一真源（Web↔原生）+ 优雅降级（无壳→PTT-only） |
| `useMobileVoice.ts` | 复刻 CanvasHost 接线（连接重连 + 字幕 rAF + 状态机 + PTT）+ 唤醒麦克风仲裁 |
| `MobileAvatar.tsx` | 小可舞台（复用表情库，居中站位 + 光晕投影 + 呼吸） |
| `MobileSubtitle.tsx` | 字幕（读 app-store，苹果风纯文字 + 留白） |
| `MobileMain.tsx` | 主界面（顶栏 + 舞台 + 字幕 + 底部 PTT 大圆 + SVG 状态指示） |
| `MobileLogin.tsx` | 邀请码登录（复用 API，苹果风 UI） |
| `MobileApp.tsx` | 入口（token 门控，复刻 KidsHubApp） |
| `main.tsx`（改） | 加 `/m` 路由分流 |

### 原生 Android 壳（grok+codex 双发，`apps/android-shell/`，17 文件）
- `MainActivity.kt`：Compose WebView + 沉浸全屏 + `onPermissionRequest` 麦克风托管 + `addJavascriptInterface("KidshubNative")` + DEBUG 放行自签证书
- `WakeWordBridge.kt`：Porcupine 封装 + JS Bridge 实现（命中→先 stop 释放麦克风→`evaluateJavascript` 通知 Web）+ 优雅降级 + 前台生命周期
- Gradle / Manifest / 资源 / README 齐全

### JS Bridge 契约（双侧对接）
- 原生注入 `window.KidshubNative`：`isWakeWordAvailable / startWakeListening / pauseWakeListening`
- Web 注册 `window.KidshubWeb`：`onWakeWord / onNativeReady`
- 麦克风互斥：录音前 `pauseWakeListening()` 释放，对话结束 `startWakeListening()` 恢复

## 验证结果（cc 自验）
- ✅ **tsc --noEmit** 零错误（Web 层类型安全）
- ✅ **vite build** 成功（507 模块 + PWA，prebuild 画内/画外铁律通过）
- ✅ **preview 主界面验收**（手机视口 375×812）：taste 苹果清新风完整渲染、小可站位、底部 PTT、console 零 error
- ✅ **Android 核心 review**：MainActivity + WakeWordBridge 严格实现契约
- ⏳ **待真机**（P3）：TWA→原生壳的麦克风真机授权、Porcupine 编译 + 童声唤醒、APK 安装

## 分阶段路线
| 阶段 | 内容 | 状态 |
|---|---|---|
| P0-P2 | Web `/m` 全链路（taste UI + 复用语音/字幕/状态/小可 + PTT）+ 原生壳代码 | ✅ 本轮完成 |
| P3 | Android 工具链 + 编译出 app-debug.apk 9.2M(揪修 grok 2 配置bug) + /m 部署生产 | ✅ 本轮完成（剩唤醒词 key）|
| P4 | 真机功耗/弱网/权限兜底 + 发布 | ⏳ |

## 风险与待验证
| 风险 | 等级 | 处置 |
|---|---|---|
| 原生 WebView 麦克风真机授权 | 待验证 | 川哥早期 demo 已验浏览器可拿麦克风，原生 onPermissionRequest 走通即可 |
| 童声唤醒识别率 <50% | 高·待真机 | PTT 兜底 + 灵敏度调优（WakeWordBridge SENSITIVITY=0.65 可调）+ 训练用童声样本 |
| Picovoice 国内激活超时 | 中 | 已 try-catch 防闪退，降级 PTT |
| 国产 ROM 后台强杀 | 中 | 前台唤醒规避（不做 Foreground Service） |

## 接手指南
1. **Web 本地 dev**：`cd apps/web && npm run dev`，访问 `https://localhost:5173/m`（/m 始终邀请码登录门，已解耦 VITE_KIDSHUB_PUBLIC；用 seed 码 KH-2P6L 等登录）
2. **Android 编译**（cc 已跑通）：`brew install openjdk@17 android-commandlinetools gradle` → `sdkmanager` 装 platform-34/build-tools-34/platform-tools → `gradle wrapper --gradle-version 8.7`（grok 缺 wrapper + brew gradle 9.6 太新不兼容 AGP 8.3.2，必锁 8.7）→ `JAVA_HOME=$(brew --prefix openjdk@17) ./gradlew assembleDebug`。产物 `app-debug.apk` 9.2M
3. **Porcupine 配置**：Picovoice Console 注册拿 AccessKey（填 `BuildConfig.PORCUPINE_ACCESS_KEY`）+ 训练「小可小可」中文 `.ppn` + 下载 `porcupine_params_zh.pv`，放 `app/src/main/assets/`
4. **dev 联调**：改 `BuildConfig.WEBVIEW_URL` 指向局域网 `https://192.168.x.x:5173/m`（DEBUG build 自动放行自签证书）
5. **复用关系**：Web 核心 100% 复用现有 `voice-client.ts` / 表情库 / 登录 API，后端零改动；改动只在 `apps/web/src/mobile/`（新增）+ `main.tsx`（加路由）+ `apps/android-shell/`（新增）

署名：cc（Claude）| 2026-06-19
