# v0.11.5 (32)：ProtoPie Cloud 默认无边框全屏

反射画面顶部出现亮边时，实机 Chrome 是最大化的应用窗口：外框7680×816，网页7680×784，顶部存在32px原生标题栏。NIO捕获整个窗口，标题栏随源图进入Warp。现将云端演示流程改为自动原生全屏，无需用户在尚未映射鼠标的画面上操作。

## 行为

1. 打开或复用专用ProtoPie Cloud窗口，等待可用原型画面。
2. 如果尚未在正确外屏全屏，先等待退出旧全屏、移动到目标外屏，再进入原生全屏。
3. 连续三次确认CDP全屏状态、实际窗口位置/尺寸、网页物理像素尺寸一致，再绑定ScreenCaptureKit并验证首帧。
4. 已在正确屏幕全屏的窗口直接复用，避免重试时反复退出全屏。
5. 「打开播放器 / 登录」仍返回内屏普通窗口，便于操作；点击「启动 / 重试预览」或「应用并切换」恢复外屏全屏。

缩放检查使用`innerWidth/Height × devicePixelRatio`与目标屏的物理像素比较，兼容Retina和浏览器缩放。原生全屏以CDP窗口状态判断；`document.fullscreenElement`只代表网页DOM全屏，不能替代此判定。

重新加载实测还发现两种原有等待问题，已一并修复：新窗口的`about:blank`及加载/认证跳转不立即报需要登录；同一登录问题连续出现三次才提示。Cloud已有可见完整原型时，允许`interactive`状态通过实际内容检查，不被尚未结束的后台资源拖住`window.load`。空壳、未加载图片、实际登录/密码页仍不会当成就绪。

本次只改变Cloud来源的窗口调用与就绪判断。本地`.pie`仍使用Studio Preview流程；不更改Warp几何、裁切数值、schema、网络或常亮设置。

## 验收

| 项目 | 结果 |
|---|---|
| 生产构建 | 开发机隔离release构建通过，最终增量8.80秒；严格签名与原designated requirement一致 |
| 回归 | 42/42项、262断言通过：原24项ProtoPie + 新18项窗口/JavaScript加载回归；实际生产Swift/AppKit/JavaScriptCore独立runner，非正式XCTest |
| 正式测试限制 | 当前CLT缺少XCTest，`swift test`未能运行；没有将独立runner称为完整XCTest |
| 自动启动 | 固定安装版重启后复用原全屏窗口，真实UI显示预览与Warp捕获接通 |
| 重新加载 | 新窗口1680接通；原1192窗口由联动流程释放，专用profile只余1个page |
| 手动入口再返回 | 控制屏普通1200×800 → 再启动 → 外屏7680×936全屏，捕获重新接通 |
| 顶栏与输出 | CDP`fullscreen`、网页inner/outer均7680×936，标题栏高度差为0；Warp覆盖层在同一外屏可见、layer1000且排在源窗口之上 |
| 参数 | 最终安装前后8个配置/预设/历史/来源键语义完全一致；曲率、倍率、裁切及网格状态与用户确认基线一致 |
| 运行身份 | 固定`/Users/futurus/Applications/NIOWarpApp.app`，UI v0.11.5(32)，进程31437，源码/安装包指纹一致 |

检查期间现场输入源模式和镜像设置发生变化，当前值均保留；与确认基线的配置差异为`capture`与`mirror`块，其余字段一致。最终安装和验收没有恢复旧输入模式、镜像或历史。专用ProtoPie窗口绑定独立于输入源选项。

最后停留在「ProtoPie 联动」，覆盖层可见、网格off。以上证明软件源窗口顶栏已去除、捕获与覆盖链路正常；真实玻璃反射后的最终观感仍以现场观察为准。没有新增鼠标逆映射，也未将Air升级。

## 回滚

- 源码回滚tag：`nio-warp-before-protopie-fullscreen-20260918` → `46130184`。
- 原v0.11.4 App、偏好及源码配对备份：开发机项目`.rollback/app-installs/20260918-030505Z-before-v0115`。
- 最终候选安装前备份：`.rollback/app-installs/20260918-031108Z-before-v0115`；这是中间候选，不替代上面的v0.11.4回滚点。
- 源码指纹：`ab87d955ab417585cf015d50986ec7cc7efb312357ade36d011556b1f9fff858`。
- 安装二进制SHA256：`6ab2b684c9e585d7b70d32f3e458c2c064fcb1c7d9581c88e55d9dea8b154df6`。
- 发布ZIP SHA256：`bcb85421cbdd07a852463ea6fe7e52411862d17f23d0d665d2b588e40005a3c8`。

恢复前正常退出NIO并另存现场最新参数；按配对备份恢复旧App和源文件，删除`created-source-paths.json`列出的本版新增源文件。schema仍为13，优先保留现场最新校正，仅按需恢复原偏好。不要对整个mycc执行reset/clean。证据位于忽略目录`artifacts/protopie-fullscreen-20260918/`与`artifacts/protopie-fullscreen-review-20260918/`，照片、完整偏好和二进制不入Git。

署名：codex（OpenAI）| 2026-09-18（Asia/Shanghai）
