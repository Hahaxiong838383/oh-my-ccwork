---
name: wordpath-app-ops
description: 家庭英语学习 App「词途」(com.hahaxiong.wordpath) 的构建、发布、装机验收与常见坑。覆盖 Gradle 构建、版本号与三通道更新发布、模拟器快速验收、安装权限自动续装、返回手势与 edge-to-edge、多邻国设计 token、练字字体子集与中文 OCR。触发词："词途"、"wordpath"、"背单词 app"、"发布 APK"、"练字模块"。
layer: 项目层
authorization: A区（构建/发布/装机验证自由；改签名、清备份、动生产更新通道先说明）
output_levels: L1
---

# 词途 App 运维（P02-英语学习App）

## 真值

| 项 | 值 |
|---|---|
| 仓库 | `~/MyAgent/2-Projects/P02-英语学习App`（remote `Hahaxiong838383/MyAgent`） |
| 包名 | `com.hahaxiong.wordpath`；debug 签名，家庭侧载 |
| 构建 | `JAVA_HOME=~/local/jdk/current`、`ANDROID_HOME=~/Android/Sdk`，Gradle wrapper 自带 |
| 更新通道 | 内网 `http://192.168.1.133:8899` → Lucky `https://wordpath.hahaxiong.cc:8666` → VPS `https://142.11.225.39.sslip.io/wordpath` |
| APK 归档 | `/data/home-studio/artifacts/english-app/WordPath-<ver>.apk`，飞牛2 `/vol1/1000/文件临时缓存/` |
| 模拟器 | `emulator-5554`（AOSP API30，无 KVM/GMS，冷启动 20–30s） |
| 当前版本 | 0.9.1（versionCode 21），156.2MB，APK 内置 Piper joe-medium-int8 |

## 构建 / 发布（照做不出错）

```bash
cd ~/MyAgent/2-Projects/P02-英语学习App
export JAVA_HOME=$HOME/local/jdk/current ANDROID_HOME=$HOME/Android/Sdk
export PATH=$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH

# 1) 改版本（app/build.gradle.kts 的 versionCode/versionName）
./gradlew testDebugUnitTest assembleDebug

# 2) 发三通道（内网目录 + VPS，Lucky 反代指回内网）
python3 content/publish_update.py --apk app/build/outputs/apk/debug/app-debug.apk \
  --version-code N --version-name X.Y.Z --notes "..." --sync-public

# 3) 归档 + 传飞牛2
cp app/build/outputs/apk/debug/app-debug.apk /data/home-studio/artifacts/english-app/WordPath-<ver>-debug.apk
trim-cli --profile fnos2 file upload /vol1/1000/文件临时缓存 <apk> --overwrite rename --yes

# 4) 回读三处清单，确认 versionCode 一致
curl -s http://127.0.0.1:8899/update.json | head -3
curl -s --noproxy '*' https://142.11.225.39.sslip.io/wordpath/update.json | head -3
```

## 装机验收（模拟器）

```bash
adb -s emulator-5554 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 shell am force-stop com.hahaxiong.wordpath
adb -s emulator-5554 shell am start -n com.hahaxiong.wordpath/.MainActivity
sleep 25   # 冷启动很慢，截图早了是白屏
adb -s emulator-5554 exec-out screencap -p > /tmp/shot.png
adb -s emulator-5554 shell uiautomator dump /sdcard/ui.xml && adb -s emulator-5554 shell cat /sdcard/ui.xml
```

- 安装权限：`adb shell appops set com.hahaxiong.wordpath REQUEST_INSTALL_PACKAGES allow|deny` 可模拟/恢复。
- 导航模式：`cmd overlay enable com.android.internal.systemui.navbar.gestural|threebutton`。

## 已踩过的坑（按重要性）

1. **升级不弹权限**：Android 在 `REQUEST_INSTALL_PACKAGES` 变化时会**杀掉进程**。必须
   ① 无权限时主动跳 `ACTION_MANAGE_UNKNOWN_APP_SOURCES`；
   ② 把待安装 APK 路径持久化（`pending_apk`）；
   ③ 启动/前台/设置三处 `syncPendingInstall()` 自动续装；`LaunchedEffect(Unit)` 补首次组合。
2. **返回直接回桌面**：Compose 单 Activity 必须自己接 `BackHandler`，并在清单开
   `android:enableOnBackInvokedCallback="true"`；还要 `enableEdgeToEdge()` +
   `statusBarsPadding()`/`navigationBarsPadding()`，否则全屏时手势条压住按钮。
3. **字体子集**：霞鹜文楷完整版 cmap 会让 fontTools 报 `AttributeError: cmap`，改用
   `LXGWWenKaiLite-Regular.ttf`；`pyftsubset --text-file=<GB2312 一级 3755 字>` 后楷体 1.7MB、毛笔 3.0MB。
4. **中文 OCR**：ML Kit `text-recognition-chinese` 首次使用要靠 Google Play 服务下载模型，
   模拟器没有 GMS，必须准备兜底 UI（提示 + 人工核对）。
5. **APK 体积**：3 套音色约 33MB + ML Kit + 4.7MB 字体，已 ~94MB；再加资源先算体积。
6. **本机测更新**：`curl` 带 `--noproxy '*'`，否则走本机代理得到假 000/502。

## 设计 token（多邻国逆向所得）

- 主绿 `#58CC02` / 深 `#58A700`；蓝 `#1CB0F6`；红 `#FF4B4B`；黄 `#FFC800`；紫 `#CE82FF`
- 文本 `#4B4B4B` / `#777777`；描边 `#E5E5E5`
- 卡片圆角 16dp；按钮 3D：底部 4dp 深色硬阴影，按下下沉
- 字体 Nunito（OFL）替代商業 DIN Next Rounded

## 文档索引

`00-项目概览` `02-调研报告` `03-实施方案` `04-核心循环` `05-装机与试用` `06/07-模型评估`
`10-UX多邻国改造` `11-反编译环境-JADX` `12-路径地图与安装权限` `13-返回与全屏兼容` `14-中文练字模块`

## Android 14+ 下载闪退（0.9.1 修）

- 现象：点「下载新版本」立刻闪退，更新永远完不成；服务端 journal 同时刻出现 `ConnectionResetError`。
- 根因：API 34 起前台服务必须声明类型，WorkManager `setForeground()` 未传
  `FOREGROUND_SERVICE_TYPE_DATA_SYNC` → `MissingForegroundServiceTypeException`，进程被杀。
- 修法：`ForegroundInfo(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)`（API 29+）
  + 清单 `<service android:name="androidx.work.impl.foreground.SystemForegroundService"
  android:foregroundServiceType="dataSync" tools:replace="android:foregroundServiceType" />`
  + `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_DATA_SYNC` 权限。
- 诊断口诀：**客户端闪退 + 服务端 ConnectionResetError 同一秒 = 下载被客户端中断**，先查前台服务/权限，不要先怀疑网络。

## UX 结构（0.9.0 起，方案 A）

- 固定底栏：今天 / 练习 / 错词（角标）/ 我的；任务页（选词、听写、批改、结果、练字批改）隐藏底栏。
- 今天：连胜/积分 → 「继续这一组」CTA → 今日目标 → 学习路径；不再有相机/相册/快捷入口。
- 练习：教材版本 → 年级（七上–九上）→ 拍课本/相册 → 单元列表 → 语文练字入口。
- 我的：语音 / 更新 / 学习 三组；根页无返回箭头。
- 拍摄只在三处：练习（拍课本）、听写完成页（拍作业）、练字页（拍字帖）。
- 设计文档 `17-UX信息架构重构方案.md`、落地记录 `18-UX方案A落地.md`、预览图 `docs/ux-preview/`。

## 更新通道（含 DNS）

| 通道 | 地址 |
|---|---|
| 内网 | `http://192.168.1.133:8899` |
| 公网 | `https://wordpath.hahaxiong.cc:8666`（域名 A → 家宽 IP，AAAA → NAS GUA） |
| 备用 | `https://142.11.225.39.sslip.io/wordpath` |

App 存的是域名不是 IP，换 DNS 指向不用发版；只有换端口/路径才需要改默认地址。
公网 IPv6 由 Lucky DDNS 维护（V6 取址必须是 `netInterface`，细节见 lucky-reverse-proxy 技能）。
