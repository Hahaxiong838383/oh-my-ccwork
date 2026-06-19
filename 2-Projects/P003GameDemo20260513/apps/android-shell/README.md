# P003「小可」Android 薄壳（原生 + WebView + Porcupine）

面向 5-10 岁孩子的 AI 语音陪伴产品「小可」的**最小原生 Android 薄壳**。

## 设计原则

- **纯薄壳**：WebView 全屏加载 https://kidshub-ai.hahaxiong.cc/m （或局域网 dev）
- 业务 100% 复用 Web（语音 WebSocket、字幕、形象、登录、状态机）
- 原生只负责：
  1. 全屏沉浸 + 竖屏锁定
  2. 麦克风权限一次性托管（Web getUserMedia 免重复弹窗）
  3. Picovoice Porcupine 前台唤醒「小可小可」
- **优雅降级**：无 AccessKey / 模型缺失 / 初始化失败 → 自动 PTT-only，App 不崩溃

## 技术栈

- Kotlin + Jetpack Compose
- minSdk 26 / targetSdk 34 / compileSdk 34
- WebView + JS Bridge（严格契约）
- ai.picovoice:porcupine-android:3.+

## 目录结构（最小可构建）

```
apps/android-shell/
├── settings.gradle.kts
├── build.gradle.kts
├── gradle.properties
├── gradle/wrapper/gradle-wrapper.properties
├── app/
│   ├── build.gradle.kts
│   ├── proguard-rules.pro
│   ├── src/main/
│   │   ├── AndroidManifest.xml
│   │   ├── assets/porcupine/README.md          ← 模型放置说明
│   │   ├── java/cc/hahaxiong/kidshub/
│   │   │   ├── MainActivity.kt
│   │   │   └── WakeWordBridge.kt
│   │   └── res/...
│   └── ...
└── README.md
```

## 编译步骤（无网环境已考虑）

1. 确保已安装 Android Studio / 命令行工具 + JDK 17
2. 把本目录作为独立 Android 项目打开（或在上级用 gradlew）

```bash
cd apps/android-shell

# 首次生成 wrapper（若无 gradle/wrapper 目录）
# gradle wrapper --gradle-version 8.7

./gradlew clean
./gradlew assembleDebug
```

产物：
`app/build/outputs/apk/debug/app-debug.apk`

安装到真机测试（模拟器麦克风/唤醒效果差）。

## Porcupine AccessKey + 中文唤醒模型配置步骤

1. 访问 [Picovoice Console](https://console.picovoice.ai/)
2. 注册/登录 → 复制 AccessKey
3. 在 `app/build.gradle.kts` 里替换：
   ```kotlin
   buildConfigField("String", "PORCUPINE_ACCESS_KEY", "\"你的真实AccessKey\"")
   ```
4. 下载 `porcupine_params_zh.pv`
5. 训练自定义唤醒词「小可小可」（建议用儿童真实声音样本）
6. 导出 Android 版本 `.ppn`，放到：
   `app/src/main/assets/porcupine/`（或 assets 根）
7. 修改 `WakeWordBridge.kt` 中 `KEYWORD_FILE` 常量为实际文件名
8. 重新 `./gradlew assembleDebug`

**无模型或 key 为空时**：App 照常启动，`isWakeWordAvailable()` 返回 false，Web 自动只用 PTT。

## JS Bridge 契约（必须严格匹配）

Web 侧已定义：

```ts
interface NativeBridge {
  isWakeWordAvailable(): boolean
  startWakeListening(): void
  pauseWakeListening(): void
}

interface WebBridge {
  onWakeWord(): void
  onNativeReady(info: { wakeWordAvailable: boolean }): void
}
```

注入名称：`KidshubNative`

关键流程：
- Web idle → `KidshubNative.startWakeListening()`
- 命中 → 原生先 `stop()` → `evaluateJavascript("window.KidshubWeb.onWakeWord()")`
- Web 要录音 → 先 `pauseWakeListening()` → 录音完再 `startWakeListening()`

## 已知风险与 TODO

- **童声识别率**：5-10 岁儿童语音基频较高，Porcupine 官方模型对成人优化较好。必须真机 + 真实儿童样本训练 + 灵敏度微调。PTT 是永远的兜底。
- **国内网络**：首次初始化 Porcupine 需要联网校验 AccessKey。无网络或被墙可能导致初始化失败（已做降级）。
- **国产 ROM 锁屏**：前台 Activity 会被杀，demo 阶段不做 Foreground Service（team 共识）。
- **电池与发热**：长时间开 Porcupine 监听会耗电，建议 Web 侧在不需要时主动 pause。
- **模型文件体积**：.pv + .ppn 约几 MB，放在 assets 打包进 APK。
- TODO（后续迭代）：
  - 正式图标资源替换
  - 发布签名配置
  - 可选：Foreground Service + 锁屏常驻（需评估电量与合规）
  - Porcupine 多关键词支持（备用唤醒）
  - 版本号 / 更新检查

## 本地 dev 联调方法

1. 启动 Web 侧 dev server（Vite）：
   ```bash
   cd apps/web
   pnpm dev --host   # 监听 0.0.0.0
   ```
   假设地址为 `https://192.168.1.105:5173`

2. 修改 `app/build.gradle.kts`：
   ```kotlin
   buildConfigField("String", "WEBVIEW_URL", "\"https://192.168.1.105:5173/m\"")
   ```

3. 在手机浏览器先访问一次该地址，信任自签证书（或在 WebViewClient 已处理 onReceivedSslError，仅 debug 放行）

4. 重新编译安装 debug APK，即可直连本地 Web。

5. Web 端通过 `window.KidshubNative.isWakeWordAvailable()` 判断是否启用唤醒 UI。

## 快速验证 checklist（安装后）

- [ ] App 能全屏打开并加载 /m 页面
- [ ] 首次启动弹出麦克风权限（拒绝也不崩溃）
- [ ] Web 能正常使用麦克风（PTT 说话）
- [ ] 控制台/调试可看到 `onNativeReady({ wakeWordAvailable: false/true })`
- [ ] 有模型+key 时，说「小可小可」能触发 onWakeWord（真机）
- [ ] 唤醒后 Web 正常进入录音，结束后恢复监听

## 署名

本壳严格遵守「只做薄壳 + 优雅降级 + 严格 Bridge 契约」原则。

---

**署名：codex（OpenAI Codex）| 完成时间**
