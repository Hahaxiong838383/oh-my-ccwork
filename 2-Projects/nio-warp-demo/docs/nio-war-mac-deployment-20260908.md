# NIO Warp：Air → nio-war-mac 部署回执

2026-09-08，用户授权增量同步 Air 项目并创建 App。

- 来源：Air /Users/rayman.chen/mycc/2-Projects/nio-warp-demo；项目最近提交 4102e3016d25266ecfbd003d8ac02204965fd5ba。
- 目标：nio-war-mac /Users/futurus/mycc/2-Projects/nio-warp-demo。
- rsync 增量同步，不使用 --delete；173 个文件、10,996,504 bytes，两端 SHA-256 全部一致。排除 .git、.venv、Python/浏览器缓存、native/.build、native/dist、.env、本地安装备份。未删除 Air 源文件，未应用 Air 的运行时校正配置。
- 目标机已安装 Apple Command Line Tools，最终包版本 26.6.0.0.1781586589；Swift 6.3.2。
- 目标机 release 构建成功，安装 v0.9.2 (17) 至 /Users/futurus/Applications/NIOWarpApp.app。严格签名验证通过，使用固定 Bundle ID 的 ad-hoc 签名；没有 Apple Development 证书。
- Bundle 源码指纹 41e15eb1e7fe9cbbc7b72c0de52b44dfdaa113117d74ebdcc7d206a8e1de1cb7，与 Air 已验收基线一致。
- 目标机 swift test 因 Command Line Tools 缺少 XCTest 模块失败；未修改测试规避依赖。在 Air 对同源代码复跑 117/117 测试通过。完整本地 XCTest 测试环境仍需 Xcode。
- 已启动固定安装版，PID 1963；CGWindowList 确认 NIO Warp 控制台在屏幕上，窗口 600×822。未获得窗口标题文本，不将 Bundle 版本冒充 UI 文字检查。
- 目标桌面 NIO Warp.command 链接至项目启动脚本。当前仅内置屏；外屏 Warp、屏幕录制授权、真实玻璃与长期性能未验收。
- 最终 rsync 校验仅有构建导致的目录时间差异，无文件内容差异。

日志在目标 /tmp/nio-warp-tests-20260908.log、/tmp/nio-warp-build-20260908.log；Air 回归日志 /tmp/nio-warp-migration-tests-20260908.log。用户随后确认完成并授权记忆落盘及本地 commit；本次不 push。

署名：codex（OpenAI）| 2026-09-08 19:31 CST
