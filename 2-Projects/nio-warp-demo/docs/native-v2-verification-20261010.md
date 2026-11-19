# Native V2 本机测试与构建回执

结果：最终完整 XCTest 已重新编译并实际执行，尚未全绿；771 项中 766 个方法通过、3 项跳过、2 个方法失败。失败的 20 条布局断言与 V1 基线逐条相同。新增 Connect 39 项与独立 Stage 脚本 13 项全部通过。最终 2.0.0（78，rc.1）App 构建与严格签名验证通过。本验证工作没有提交、打 DMG、现场部署或修改产品代码。

本回执记录 2026-10-10 17:15 完成的最终测试快照和其后顺序完成的 release 构建，包含依据 Connect 2.13 Stage/D3 公开 host 结构修正的 layout/readiness、单来源选项以及播放列表原生 fit。Stage 13 项使用真实 Swift 生成脚本及合成 DOM，不能替代真实浏览器、消息输入、现场硬件或光学验收。

## 结果与基线差异

| 验证 | 结果 |
| --- | --- |
| 最终 V2 完整 XCTest | 771 项：766 个方法通过、3 项跳过、2 个方法失败；20 条断言失败、0 unexpected；exit 1，97.090 秒 |
| V1 隔离基线完整 XCTest | 732 项：725 个方法通过、3 项跳过、4 个方法失败；22 条失败，其中 2 条 unexpected 是隔离目录漏 calibration 文件；exit 1，90.448 秒 |
| 补齐基线原始 calibration 资源后重测 MouseMappingMathTests | 8 项通过，0 失败；未重跑整个基线，也不据此宣称基线全绿 |
| 新增 Connect 组 | 最终全量运行中 39 项全部通过，0 失败、0 跳过 |
| 独立 Connect Stage/D3 脚本 fixture | 13 项全部通过，0 失败、0 跳过；真实 Swift 生成脚本，合成 DOM |
| 原来跳过的 legacy browser/page 原 socket 用例 | 独立 loopback WebSocket 补测通过，2 个真实不同连接，1 项通过 |
| 原来跳过的 legacy cancellation 用例 | V1/V2 同 fixture 均真实请求到达后超时；20 秒终止，exit 124，不能记为通过 |
| 正式口令环境验证 | 按测试设计跳过，未注入口令、未读取或保存正式密码 |
| release / App 包装 | build-app.sh 成功，2.0.0 / 78 / rc.1 |
| codesign | `--verify --deep --strict --verbose=4` 成功，临时 ad-hoc 签名；本机无有效签名证书 |

V2 相对 V1 增加 39 项：configuration migration 3、input 5、option UI 5、playback migration 3、playlist fit model 3、playlist fit UI 3、runtime 6、service probe 6、source 5。Stage 脚本 13 项另计，不混入 771 项 XCTest。用日志提取并排序比较，剩余 20 条布局失败的完整断言消息与基线一致：

- `TabLayoutTests.testMinimumWorkbenchShowsAllSevenTabsAndReachableInspectorControls`：6 条，local 页面按钮左边缘 x=-3，断言要求 >=-1。
- `TabLayoutTests.testQuitButtonIsUniqueAtTopRightAndAvailableOfflineAcrossAllModules`：14 条，按钮右边缘 947/1127，断言上限 943/1123。

没有弱化断言，也没有修改这些布局的产品实现。legacy cancellation 补测中 marker 证明服务器收到命令后才取消；服务器故意不回命令结果，用于检查真实 pending receive 的取消。两版均超时，暂记为已有行为或本机 runtime 问题，未定位到足以修复产品的根因。

## 仅测试修复

1. `VerticalAspectEditorTests.swift` 增加缺失的 `import simd`，解决基线已有 `simd_length` 编译错误。
2. `ProtoPiePlaybackUITests.swift` 的离屏窗口 fixture 设置 `window.isReleasedWhenClosed = false`。原文件两版完全相同；V1/V2 独立运行都 exit 139，NSZombie 明确报告 `-[NSWindow release]: message sent to deallocated instance`。修复后此方法通过，完整测试能够跑完。
3. 旧 `ProtoPieConnectMigrationTests.swift` 原断言仍要求 Connect 应用 Cloud 的铺满/垂直覆盖、继承原 scaleToFit=false，落后于本候选明确的原生 fit 合同。首次最终运行为 771 项、765 方法通过、3 跳过、3 方法失败／23 条断言。经根代理同意，仅更新这一测试：强断言 Connect 不覆盖继承的 Cloud 几何、fit 默认 true、原 item 字段序列化保存且切回 Cloud 后覆盖有效，再唯一重跑一次最终全套；旧失败证据保留。

这些都不是产品修复，没有弱化基线布局断言。隔离基线仅临时补前两处用于对照，完成后已撤回，并与基线提交逐字节核同。漏掉的 calibration 从基线提交 `7130321c` 原样取回，没有更改内容。

## 可复用本机 runner

本机为 macOS 26.4.1，CommandLineTools Swift 6.3.1。现有 Xcode 的 Swift 因 USDKit 符号缺失不能启动；没有改全局 xcode-select，没有重装 Xcode 或依赖。

`native/scripts/test-native-local.sh` 用 CLT 编译，显式给现有 Xcode XCTest 的 `-F`、`-I`、`-L`、两条 rpath。这里 CLT 的 `swift test` 编译成功后没有真正执行测试，所以脚本必须再调用 Xcode `xctest`，保留真实 exit code 与 passed/failed/skipped 方法计数。

从项目目录运行完整测试：

```sh
NIO_NATIVE_TEST_LOG_DIR=/tmp/nio-native-tests-full native/scripts/test-native-local.sh
```

独立运行指定方法或多个组（XCTest selector 使用逗号分隔）：

```sh
NIO_NATIVE_TEST_FILTER=NIOWarpAppTests.ProtoPieConnectRuntimeTests \
NIO_NATIVE_TEST_LOG_DIR=/tmp/nio-native-tests-runtime \
native/scripts/test-native-local.sh
```

参数：`NIO_NATIVE_TEST_DIR` 可选隔离 native 目录；`NIO_NATIVE_TEST_XCODE_APP` 默认 `/Applications/Xcode.app`；`NIO_NATIVE_TEST_DEVELOPER_DIR` 默认 `/Library/Developer/CommandLineTools`；`NIO_NATIVE_TEST_TIMEOUT_SECONDS` 默认 300；`NIO_NATIVE_TEST_SKIP_BUILD=1` 仅对已有测试包运行，输出会明确说明未重编译。最终验证应使用默认重编译。

runner 已用基线 UI 单方法验证编译和执行（1 项通过），旧快照曾用 SKIP_BUILD 运行 Connect 28 项；最终 771 项使用默认重编译，包含所有稳定生产文件和新测试，已真正执行 XCTest。

WebSocket 补测使用 `native/scripts/verify-browser-control-local.py`：仅监听 127.0.0.1 随机端口，每次进程上限 20 秒；使用本机已有 Python websockets 15.0.1，不安装依赖。当前工作区默认 Python 3.11 未装此模块，已验证的解释器为 `/opt/anaconda3/bin/python3`（3.12）：

```sh
/opt/anaconda3/bin/python3 native/scripts/verify-browser-control-local.py native \
  /tmp/nio-legacy-sockets.log \
  NIOWarpAppTests.ProtoPieBrowserControlTests/testLegacyUsesOriginalBrowserAndPageSocketsAndRemainsFixedAfterPreferenceChange

/opt/anaconda3/bin/python3 native/scripts/verify-browser-control-local.py native \
  /tmp/nio-legacy-cancellation.log \
  NIOWarpAppTests.ProtoPieBrowserControlTests/testLegacyCancellationDoesNotCreatePersistentFallbackConnection
```

## 构建与签名

```sh
cd native
DEVELOPER_DIR=/Library/Developer/CommandLineTools \
NIO_WARP_APP_VERSION=2.0.0 NIO_WARP_APP_BUILD=78 NIO_WARP_RELEASE_CHANNEL=rc.1 \
./scripts/build-app.sh
codesign --verify --deep --strict --verbose=4 .build/app/NIOWarpApp.app
```

最终构建 30.94 秒，产物 `native/.build/app/NIOWarpApp.app`，`lipo -archs` 为 arm64，`file` 为 Mach-O 64-bit executable arm64，最低系统版本 14.0。`otool -L` 仅有系统 Framework 与 Apple Swift 动态库，无 XCTest 或开发者目录动态依赖。严格签名验证 exit 0，ad-hoc／无 TeamIdentifier；当前本机没有有效签名证书。本机验证不能替代另一系统版本上的启动验收。

- Mach-O SHA256：`393b3b614756b795c1dc9bd38ee6f3bea8c73df68af5cbeece6b9a157820b899`
- Info.plist SHA256：`6b52cb4398ba157e909582cd38df822e09c9ff298f1a95a17cf98fb6448094ca`
- source digest：`e278c6824727d1c03c209ad6780ff1303077596344a3c6bbe9010cddc5ad592d`
- ad-hoc CDHash：`7a372f58f6e02e12c749262606c604fa054f8744`
- App 文件清单 SHA256：`e043ed998347a11943da8ecf3d70abd237b901ce7daee5e3a01c3fe31799f055`；定义为相对路径排序后全部文件 `sha256  relative-path` 清单文本的 SHA256，清单同时保留。

已按 build-app.sh 同一规则重新计算当前 Sources／Package／默认配置的 digest，与 App 内元数据相等。以上是最终 App 快照；DMG 由根代理后续另行打包，其 hash 另记。

只读最终复审：先前单来源本地回退丢铺满、Connect 内部取景入口未禁用、播放列表显示不支持的取景选项，均已由根代理／播放列表代理修正并有最终 UI 回归通过；本验证代理未改产品。尚留低风险显示文案：原始尺寸模式的 session title 仍显示“原生等比”，只记录，不因此更改产品或追加重测。消息连通性与现场画面验收仍未验证。

## 留存证据

完整日志同时留在 `/tmp` 和项目 `artifacts/native-verification-20261010/`：

- `nio-v2-final-native-contract-20261010/`、`nio-v2-final-native-contract-runner.log`：最终重新编译并实际执行 771 项／39 项 Connect，766 passed／3 skipped／2 failed 方法，20 条布局断言失败。
- `nio-v2-final-native-20261010/`、`nio-v2-final-native-runner.log`：旧迁移测试合同更新前的 771 项／23 条失败证据。
- `nio-v2-final-stage-fixtures.log`：13 项 Stage/D3 脚本 fixture 通过。
- `nio-v2-xctest-fixturefixed.log`：此前 V2 760 项实际执行历史。
- `nio-v1-baseline-xctest-runtime.log`：基线完整 732 项。
- `nio-v1-baseline-math-resourcefixed.log`：补齐原始资源后的 8 项。
- `nio-v2-uicrash-zombies.log`、两版 `uicrash-isolated.log`：原窗口 fixture 崩溃证据。
- `nio-native-runner-connect/xctest.log`：Connect 28 项。
- `nio-native-runner-baseline-ui/`：runner 编译参数与 fixture 单方法验证。
- `nio-v2-legacy-original-sockets.log`、`nio-native-runner-browser-original.log`：原 socket 补测通过。
- `nio-v2-legacy-websocket-xctest.log`、`nio-v1-legacy-cancellation.log`：取消用例超时，不是成功记录。
- `nio-v2-final-release-build78.log`、`nio-v2-final-build78-codesign-verify.log`：最终 release 与严格签名验证。
- `nio-v2-final-build78-metadata.json`、`nio-v2-final-build78-app-files.sha256`：最终版本、architecture、otool、签名与各 hash 完整记录。

署名：codex（OpenAI）| 2026-10-10 17:18（北京时间）
