---
name: ios-cross-build
version: 1.0.0
description: 在 iSH（无 Xcode）环境下手搓 iOS IPA 安装包。触发场景：用户要在当前环境构建 iOS App / IPA、交叉编译 arm64 iOS 可执行文件、把 Web 前端打包成 iOS 应用、复现"学习卡"App 的构建、问"不用 Xcode 能不能做 iOS 开发/打包"等。提供工具链验证、编译链接命令、Payload 打包流程、WKWebView 混合壳模式与全部已知坑位。
---

# iOS 无 Xcode 交叉编译打包

在 iSH/Alpine 里用 clang + ld64.lld + theos iOS SDK 编译 arm64 iOS 可执行文件，组装成 .app 再打成 .ipa。已用"学习卡"App（WKWebView 壳 + HTML 前端）实测通过。全程不需要 Xcode/Mac。

> **适用环境：iSH/Alpine（iPhone 上）。** 2026-08-06 在 Mac（mycc 主机）实测：`ld64.lld` / `ldid` / `apk` / `/tmp/iPhoneOS16.5.sdk` **全部缺失**，本机直接跑第 2–5 节命令必然失败。Mac 上有 Xcode（`/Applications/Xcode.app`），要打 iOS 包走 `xcodebuild` 即可，不需要本 skill。本 skill 在 Mac 上的用途是**查工艺与坑位**（§6 WKWebView 混合壳、§9 坑位表），执行请回 iSH。

## 1. 环境前提（先验证）

```sh
command -v clang ld64.lld zip   # 三者缺一不可
ls -d /tmp/iPhoneOS16.5.sdk     # iOS SDK 必须存在
```

- 工具：`apk add clang lld zip`（llvm 自带 ld64.lld，路径 /usr/bin/ld64.lld）
- SDK：theos 的 iPhoneOS16.5.sdk。**必须解压到 /tmp**（workspace 文件系统不支持 symlink，SDK 内大量 symlink 会坏）。缺失时从 GitHub `theos/sdks` 下载 iPhoneOS16.5.sdk.tar.xz 解压到 /tmp。
- 若 SDK 丢失，skill 无法自动恢复，需重新下载解压。

## 2. 编译（.m → .o）

```sh
SDK=/tmp/iPhoneOS16.5.sdk
clang --target=arm64-apple-ios16.5 -isysroot "$SDK" \
  -fobjc-arc -c AppDelegate.m -o AppDelegate.o
```

## 3. 链接（.o → 可执行）——关键坑

**不要用 `-fuse-ld=lld`（clang 19 下报错），必须手动调 ld64.lld：**

```sh
ld64.lld -arch arm64 -platform_version ios 16.5 0 \
  -syslibroot "$SDK" \
  -framework Foundation -framework UIKit -framework WebKit \
  *.o -o 学习卡
```

- `-platform_version ios 16.5 0` 是必需的，缺了报 `must specify -platform_version`
- 所有用到的 framework 都要显式 `-framework`（Foundation/UIKit/WebKit 最常见）
- 验证产物：magic 0xfeedfacf（64位 Mach-O）、cputype 12（arm64）、filetype 2（MH_EXECUTE）
- 可选 ad-hoc 签名：`apk add ldid` 后 `ldid -S 可执行文件`（未签名也能装，TrollStore 不需要签名）

## 4. 组装 .app

```
Payload/学习卡.app/
├── 学习卡            # 链接出的可执行文件（名字必须 = Info.plist 的 CFBundleExecutable）
├── Info.plist
├── index.html        # WKWebView 加载的入口（Web 资源直接放根目录）
└── ...其他前端资源
```

Info.plist 必需键：CFBundleIdentifier、CFBundleExecutable、CFBundleName、CFBundlePackageType(APPL)、CFBundleVersion、CFBundleShortVersionString、MinimumOSVersion、UIDeviceFamily。**UILaunchScreen 必须给空字典**，否则启动异常。

## 5. 打 .ipa

```sh
# 在 Payload 的父目录打 zip，顶层必须是 Payload/，否则装不上
cd build && zip -qry ../学习卡_v1.0_未签名.ipa Payload
```

## 6. WKWebView 混合壳模式（Web 前端 → iOS App）

- 原生壳：AppDelegate + ViewController，VC 里 WKWebView 加载 bundle 内 index.html
- JS → 原生：`window.webkit.messageHandlers.bridge.postMessage({type:'save',data})`，原生实现 `userContentController:didReceiveScriptMessage:` 写 Documents/data.json
- 原生 → JS：启动时 `evaluateJavaScript` 注入 `window.__INITIAL_DATA__`（或 WKUserScript atDocumentStart）
- **浏览器预览兜底**：JS 里检测 `window.webkit` 不存在时改用 localStorage，这样前端可在内置浏览器直接调试
- 已知坑：该 SDK 的 WKPreferences **没有** `allowFileAccessFromFileURLs` 属性（未暴露），不要尝试设置

## 7. 资源与图标

- 图标用 py3-pillow 生成（`apk add py3-pillow`）：**渐变等复杂绘制先画小图再放大**，1024px 逐像素太慢
- 图标尺寸：20/29/40/60/76/83.5@2x@3x + 1024（至少 1024 主图标，CFBundleIcons 指向它）

## 8. 一键构建

`scripts/build.sh` 是通用打包脚本（编译全部 .m → 链接 → 生成 Info.plist → 打 .ipa），用法：

```sh
# iSH 内原路径
sh /var/minis/skills/ios-cross-build/scripts/build.sh <App名> <BundleID> <源码目录> [版本号]
# mycc 主机安装路径（仅供查阅/编辑，本机工具链不全跑不通，见顶部「适用环境」）
sh ~/.claude/skills/ios-cross-build/scripts/build.sh <App名> <BundleID> <源码目录> [版本号]
```

产物：`<App名>_v<版本>_未签名.ipa`。安装方式：TrollStore / AltStore / 自签（未签名 IPA 无法直接侧载，需签名工具或 TrollStore）。

## 已验证坑位清单（速查）

| 坑 | 处理 |
|---|---|
| `-fuse-ld=lld` 报 unrecognised emulation | 手动调 /usr/bin/ld64.lld |
| 缺 -platform_version | 链接参数必须带 `-platform_version ios 16.5 0` |
| SDK 解压到 workspace 后坏 | 必须放 /tmp（symlink 不支持） |
| IPA 装不上 | zip 顶层必须是 Payload/ |
| 启动黑屏 | UILaunchScreen 空字典必须有 |
| WKPreferences.allowFileAccessFromFileURLs | SDK 未暴露，别设置 |
| 1024px 图标生成慢 | 小图绘制再放大 |
| 版本升级覆盖安装 | 同 bundle id 同证书覆盖安装数据不丢（Documents/data.json 保留） |
