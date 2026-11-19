# ProtoPie 预览来源与输入兼容性审计（v0.13.9）

审计日期：2026-09-18。代码基线：`1956a6e3ed13fc35496820cd8038364899367124`；开发机运行版本：**v0.13.9（61）**。

## 结论

当前演示使用 **ProtoPie 官方 Cloud 网页播放器，运行在专用 Chrome 中**。原型内容与交互没有重做，但它也不是 ProtoPie Studio 的本机 Preview Window。NIO Warp 负责播放器布局、独立内容屏、画面捕获与畸变校正，以及键鼠事件向原页面的转发。

输入通道是通用实现，没有把 `2 → 0 → 1 → 2 → 3 → 4` 写成生产白名单。在线原型新增普通按键、点击、拖动等交互，在发布并实际加载新版后，无需逐个增加 NIO 键位代码。**当前尚不支持所有原生操作无差别透传**：Esc 被工作台占用，Cmd／Ctrl 键盘组合不转发，另有高级输入边界和双侧修饰键缺陷。

本次为核查与记录，**未修改生产代码、未升级应用、未变更现场校正参数或退出键策略**。

## 播放器与输入链路

`ProtoPieConfiguration.playbackURL()` 验证官方 HTTPS Cloud 原型地址，仅调整播放器 UI、缩放和背景参数；`ProtoPieSystemDriver` 用专用 Chrome profile 和 `--app` 打开该页面。`ProtoPieWidthFit` 注入的布局代码管理宽度、比例和位置，不替代原型交互实现。

当前独立内容屏路径：本机输入 → NIO 输出窗口的输入捕获 → 校正坐标反算／键盘编码 → CDP `Input.dispatchMouseEvent`／`Input.dispatchKeyEvent` → 官方 Cloud 页面。原型是否响应仍由官方播放器和原型触发器决定。事件接管要求处于校正演示、拥有相应输出表面与输入焦点，并非全局无条件转发。

本轮只读实机核查记录：

| 项目 | 结果 |
|---|---|
| 运行应用 | v0.13.9（61） |
| 页面 origin | `https://cloud.protopie.io` |
| 官方原型地址校验 | `isOfficialPrototype = true` |
| 页面状态 | `readyState = complete` |
| 官方播放器根节点 | `webplayer-root` 存在 |
| 播放器视口 | 1920 × 600 |
| NIO 按宽布局 | `widthFit` 存在 |

本记录不收录私有原型链接、设备地址、凭据或原始全量日志。

## 支持矩阵与边界

下表“有实现”指当前生产代码具备捕获、编码或发送路径，**不代表每个键、每种组合和每个原型动作均已通过本机人验**。

| 输入 | 当前实现 | 限制或注意事项 |
|---|---|---|
| A–Z、主键盘 0–9、常用标点、空格 | 有通用键码与布局文本转发 | 非表内可打印字符可走文本，但 `code` 可能为 `Unidentified`，不是所有键盘布局完整等效 |
| 数字小键盘 0–9、小数点、加减乘除、等号、Enter | 有独立映射及小键盘位置标记 | `201234` 是现场用例，不是支持范围 |
| 方向键、Tab、Enter、Backspace、Delete、Home／End、PageUp／PageDown | 有通用转发 | 最终行为由播放器和原型定义；浏览器默认行为仍可能参与 |
| Shift、Option／Alt | 左右键码与修饰位有实现 | 双侧同按再释放一侧存在下述缺陷；含 Cmd／Ctrl 的键盘组合不转发 |
| F1–F20 | 有键码映射 | 实际硬件须产生对应功能键事件；不能据此承诺亮度、音量等系统媒体键透传 |
| 持续按键、自动重复、普通多键同时按住 | 有所有权与顺序管理 | 失焦／停止时补释放；需要各原型的实际交互验收 |
| Esc | 被 NIO 用于退出校正、返回工作台 | 不发送到 Cloud 原型；含修饰键的 Esc 也未作为普通原型键支持 |
| Cmd／Ctrl 本身及其键盘组合 | 保留系统处理 | 不通过 CDP 键盘桥发送给原型；不代表它们必然会作用于源 Chrome 页面 |
| Caps Lock、Fn 本身 | 未作为独立原型键转发 | 不等于这些键对系统文本／功能键行为完全无影响 |
| 鼠标移动、悬停、左／右／中键、长按、拖动 | 有通用事件转发 | 原型是否配置相应触发器、播放器如何解释由官方页面决定 |
| 单击、双击 | 有 `clickCount` 转发 | 计数限制为 1～2，不保留三击语义 |
| 横向／纵向滚轮 | 有 delta 转发 | 不等同于多指缩放、旋转等手势 |
| 鼠标侧键、多点触控、缩放／旋转、压力手势 | 未完整实现 | 没有相应的完整事件捕获／合成链路 |
| 中文等输入法组合输入 | 未完整实现／验证 | 普通布局文本转发不能替代 IME composition、候选和提交链路 |

ProtoPie 官方 Press 文档列出的支持键包括字母、数字、方向键、Esc、Tab、空格和退格。**因此 Esc 是当前 NIO 与官方能力之间的明确缺口**。官方触发器还包括 Pinch／Rotate，不能以普通鼠标拖动已通过来代表这些手势已经支持。[ProtoPie 官方触发器文档](https://www.protopie.io/learn/docs/interactions-triggers)

官方 Cloud 支持浏览器预览与上传覆盖原型；Cloud 网页、Studio Preview 和移动端 Player 不应混称，也不能据此保证它们的全部能力完全一致。[ProtoPie Cloud 官方说明](https://www.protopie.io/learn/docs/cloud-getting-started)

## 在线原型更新

1. 在 ProtoPie 发布／覆盖在线原型，并让开发机加载新版。不能把“链接相同”视为已经加载最新内容，也未验证自动热更新。
2. 页面刷新或主文档导航时，现有输入绑定失效。`Runtime.executionContextsCleared`／主 `Page.frameNavigated` 会停止旧绑定，避免旧文档排队的点击和按键误发进新页面。
3. 等新版播放器加载后重新进入演示，建立对应新文档与视口的输入绑定；若新版改变了画布或布局，还需核对取景和坐标映射。
4. 新增普通按键无需改代码，但应实际验收新交互。新增 Esc、Cmd／Ctrl 组合、IME 或多指手势时须先处理兼容性缺口。

## 代码发现：尚未修复

### 双侧 Shift／Option 释放判定

`NativeMouseInputCapture.keyboardInput()` 对 `flagsChanged` 以聚合 `.maskShift`／`.maskAlternate` 判断当前侧是否按下。左右同类修饰键同时按住时，释放其中一侧后，另一侧仍使聚合标志保持为真，当前实现可能把该次释放误判成新的非重复 `down`。

`NativeKeyboardOwnership` 会继续转发该事件；`MouseInputTransport.sendKey()` 发现该键已经处于按下状态，将重复的非自动重复 `down` 判为 `invalidEvent`，进入失败停止路径。**这是源码推导出的缺陷，尚未进行该双侧按键序列的实机复现，也未修复**；不能归因于已经修复的圆圈资源下载故障。

### Esc 修饰键范围不一致

原鼠标捕获路径的 Esc 条件排除 Cmd／Ctrl／Option，但未排除 Shift／Fn；独立 `PresentationExitCapture` 的普通 Esc 条件同时排除 Shift／Fn。因此不同接管路径对 Shift／Fn + Esc 的判断不一致。此项为源码证据，尚未实机验收。

## 验证范围与待办

- 已有现场人验：本机鼠标移动／点击与数字键盘 `201234` 演示正常；v0.13.9 长按、松开、Esc 返回、重新进入以及原圆圈移动／点击正常，没有自行退回。
- 本轮：源码审计和运行页面的只读核查。未在正式原型盲发全键盘序列，未声称所有触发器、全部组合键、所有鼠标设备已全量验收。
- 待修：按每侧实际状态识别 Shift／Option 的按下与释放，补双侧按键顺序、释放和不中断测试，再安排本机复验。
- 待定：让普通 Esc 透传原型，并改用专用组合键返回工作台；这只是建议，**尚未确定具体组合、尚未实施**。实施时必须同时统一两条退出入口，保留可靠退出与可见鼠标恢复。
- 待明确需求后补齐：Cmd／Ctrl 组合、IME、侧键、三击及多指手势。不能因通道通用而默认这些已支持。

主要源码：`MouseKeyboardEvent.swift`、`NativeMouseInputCapture.swift`、`PresentationExitCapture.swift`、`MouseMappingController.swift`、`MouseInputTransport.swift`、`ProtoPieConfiguration.swift`、`ProtoPieSystemDriver.swift`、`ProtoPieWidthFit.swift`，均位于 `native/Sources/NIOWarpApp/`。既有键盘测试位于 `native/Tests/NIOWarpAppTests/MouseKeyboardEventTests.swift`。

署名：codex（OpenAI）| 2026-09-18
