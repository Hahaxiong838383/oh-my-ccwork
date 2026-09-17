# v0.11.0 (27) 工作台开发验收

2026-09-17。结论：**原生实现及软件自检完成，197/197 自动化测试通过；本轮未安装到 Air 或覆盖开发机旧版。真实 ProtoPie 播放与外屏输出待现场联调。**

## 实现范围

- 六模块：画布与输入、整体校正、局部微调、标定与画质、预设与历史、ProtoPie 联动。最后一项严格位于最右侧。
- 默认普通窗口层级；嵌入两个微调编辑器，不新增编辑窗口；大预览、可调整右栏、独立滚动、固定全局操作和状态。
- 导航保留草稿、选点和相机；跨层修改校验保护、同工具连续微调合并；撤销不误消费历史；离线和重连行为回归。
- ProtoPie 独立配置、文件书签、专用 Cloud 播放器、Studio Preview 识别、手动登录入口、有限恢复与停止、失败回退。
- 捕获绑定窗口与进程，通过独立候选流确认有效首帧后切换；停止/取消有代次保护。控制状态在主 actor，样本由锁保护的帧路由接收。
- 原几何算法、保存参数结构和既有标定模板保持原语义。

## 测试证据

| 项目 | 结果 |
|---|---|
| 测试设备 | Air，Xcode 26.6 / Swift 6.3.3 |
| 隔离目录 | `/tmp/nio-workbench-tests-20260917.fhQujl` |
| 完整清理构建 | 13.91 秒，无编译警告 |
| XCTest | **197/197 通过**，20.40 秒，完成09:22:54 CST |
| 原生布局 | 1040×650、1220×790；六模块预览容器尺寸/位置不变；真实 ProtoPie 面板可滚动 |
| 编辑器 | 无额外 NSWindow、共享物理视角往返不漂移、草稿与待校验提交保留 |
| 配置保护 | 无外屏可展开高级区但参数只读、导航不保存/重启捕获、离线撤销不消耗历史、忙态撤销仅取消候选、跨模块不覆盖旧基线 |
| ProtoPie | 假驱动状态机、取消/恢复/旧源回退、首帧回调、URL/书签校验、真实 JavaScriptCore DOM 就绪检测 |

正式测试前逐个核验34个源码/测试文件，结束后与本地逐字校验一致。包含一次旧缓存发现及修正：初期 tar 统一 mtime 导致 Swift 沿用旧测试产物，最终验收已执行 `swift package clean` 后完整构建，未将旧缓存结果当作新版通过。

源码清单摘要（Sources + Package）：`29574b50236e4efe47de0a83799a10ab3ecc1701723ec09d6e88b06bf9f725b6`。

含测试快照摘要：`3432c5884fe0cbaec053ba8a5484faad256debca694947b1e493ecca59a0b5a0`。

最终日志已落盘 `artifacts/workbench-20260917/swift-test-final.log`；逐文件清单 `tested-source.sha256`。原生合成预览保存在本机 `/tmp/nio-workbench-previews-20260917-final2/`，用于布局检查；标题中的版本来自 XCTest 宿主，不代表安装版，不作为实机交付截图。

## 构建包

本机 CLT release 最终增量构建13.36s，包内版本 **0.11.0 (27)**，`codesign --verify --deep --strict` 通过。

| 内容 | 值 |
|---|---|
| 本地包 | `artifacts/workbench-20260917/NIOWarpApp-v0.11.0-27.zip` |
| Bundle 源码指纹（含配置模板） | `e77b6c4933b6a1f79ef4545d8f1c2f3bac99cd1de043f2d34ccf425907b5fa95` |
| ZIP SHA-256 | `863641fe3f0216a0b474a31b55544b012aebc8601235fd14e47721ba1448a84b` |
| 可执行文件 SHA-256 | `afbc4abc67129359581c0ee99a4cf7e7c2acd0b9e5c08fa49b21288de717ae84` |
| 签名 | 本次构建包为 ad-hoc；后续安装 Air 时沿用 Air 已有稳定签名身份 |

nio 开发机同源 release 构建和签名验证也已通过（最终增量构建8.74秒）。隔离目录：`/Users/futurus/mycc/2-Projects/nio-warp-demo/.validation/workbench-20260917-091906-614c82`。源码指纹与本地包一致；开发机 ZIP SHA-256：`ee76a0afe69624e1fce42c87bf066f780923e33004e0c8bad364879df1457af3`，二进制 SHA-256：`118e8400cf8f134462893397d165ce9c1e52278fcf97ed61a815a931c992ff9c`。构建回执保存在 `artifacts/workbench-20260917/dev-validation/`。

## 安装状态与边界

- **Air**：仍为用户已验收 v0.10.0 (26)，应用和用户偏好未被本轮测试改写。
- **nio 开发机**：仍为 v0.9.10 (25)，旧 ProtoPie 自动流程保留；本轮在独立 `.validation` 目录完成 release 构建与签名检查，并只读复核真实 bundle `io.protopie`、旧 URL 参数和登录/窗口位置差异。设备目前只有内屏，不具备真实外屏验收条件。
- ProtoPie 测试不启动真实浏览器或 Studio；Cloud 账户权限、Studio AX 窗口与当前原型、外屏实际画面仍需安装后的现场验收。
- 新 Chrome profile 可能要求登录；后续升级开发机前需迁移旧完整链接和自启设置，并复核新源尺寸与构图。
- 新版功能不等于已经完成真实玻璃光学、鼠标输入逆映射或长时间 GPU 稳定性验收。

## 回滚

开发前标签 `nio-warp-before-workbench-20260917` → `3ef68cf6b65c83377323bb1e8f532b6a18c26336`；只读源码/配置模板归档 SHA-256 `d19fe818887602be029f6ceee38ba1af6ec82065c69a092d7b90fa5c34dc635d`，位于 `.rollback/20260917-before-workbench/`。

软件验收标签：`nio-warp-v0.11.0-software-tested-20260917`（197项软件测试通过，不等于真人或实屏验收）。

当前安装版本均未覆盖，无需现场回滚。本轮代码应以独立实现提交回退，不对整个 mycc 工作区执行 reset/clean，避免触碰其他项目。

署名：codex（OpenAI）| 2026-09-17
