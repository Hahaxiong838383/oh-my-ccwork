# 同机 Connect 和播放器设置

状态：RC；已核对 Connect 2.13 公开静态播放器结构；客户真实原型、消息闭环、协议与套餐仍待验收。当前完成原生尺寸模式接入，尚未完成 Connect 横向铺满和原型内部取景适配。

1. 客户在 ProtoPie Connect 内自行登录。记录版本、实际功能等级和本机服务端口，确认 Custom Plugins / Bridge Apps 权限（Enterprise 专属）。NIO Warp 的页面访问结果不会证明订阅授权。[官方功能表](https://www.protopie.io/learn/docs/connect-protopie-connect-pro-vs-enterprise)
2. 通过 `+ New` 或拖入真实 `.pie` 加载原型，在 Connect 浏览器按钮打开播放器。先在 Chrome 单独确认画面和交互可用。[官方原型加载和浏览器播放](https://www.protopie.io/learn/docs/connect-managing-testing-prototypes)
3. 复制完整播放器 URL，如 `http://localhost:9981/pie?pieid=...&name=...`。在 NIO Warp 普通模式的 Connect 来源中粘贴，保留 pieid、名称和所有查询参数。不要自己填一个猜测的 pieid；新增与替换原型的身份行为不同。[官方 pieid 说明](https://www.protopie.io/learn/docs/connect-managing-testing-prototypes)
4. 测试来源并开始播放，分别观察页面可访问、播放器画面/尺寸、捕获首帧和校正输出。旧屏幕参数应先核对；更换来源不构成重新标定的理由。消息链路须另外测试，无法验证的状态保持“未验证”。
5. SDK `config.local.json` 的 `serverURL` 只填写服务 origin，默认 `http://localhost:9981`，不要粘贴 `/pie?...` 播放器 URL。首次用演示原型确认明确协议：默认 legacy2 对应官方旧示例；modern4 只适合支持 3/4.x 服务协议的目标。遇 connect_error 时核对版本和权限，不盲试业务命令。legacy2 仅允许本机 loopback；modern4 可配置另一个服务地址，跨机使用需客户独立授权和另做安全/网络验收。[官方 Bridge 示例](https://github.com/ProtoPie/protopie-connect-bridge-apps/blob/badcc7b78bd8853c99baa6f2fbcc4f5bba4e9eae/node-bridge/index.js)、[Socket.IO 兼容表](https://socket.io/docs/v4/client-installation/#version-compatibility)
6. 启动 Bridge，等待 connected；逐行输入演示消息，每次间隔至少 100ms。核对 Connect 的消息面板确实收到值，原型 Receive 改变 Chrome 画面，最后核对 NIO Warp 输出。`submitted` 无送达保证，不作为验收证据。[官方消息调试入口](https://www.protopie.io/learn/docs/connect-managing-testing-prototypes)

## Connect 2.13 的显示与光标边界

本次核对的 Connect 2.13 公开播放器使用 `#pie-screen` 的 Stage 和 D3 管理缩放、位置与鼠标基准；它采用独立于 Cloud `webplayer-root` 的结构。本 RC 使用 Connect 自己的 `fitToScreen`（适合屏幕）和 `originalSize`（原始尺寸）模式，保留其 D3 transform 与鼠标坐标基准。仅核对公开静态结构不能证明客户原型已经可播放，也不能代替硬件/玻璃验收。

**Connect 横向铺满与原型内部取景在此 RC 禁用，并显示不支持提示。** 当前版本不承诺 Connect 按宽裁切铺满、内部取景滑块或完整宽铺满适配已完成。客户在原生两种尺寸模式中选择并验收；不通过手工修改 D3 transform 绕过限制，以免改变输入坐标基准。

原有 Cloud 来源的横向铺满功能和 NIO Warp 整幅输出的物理 Y 位置调节保持原有行为。整幅物理 Y 调节改变校正输出位置，与 Connect 原型播放器内部取景是不同操作；禁用后者不等于禁用整幅输出位置调节。

Connect 使用其原生光标 `auto` / `none` 行为，需在实际播放器中验收。此 RC 不承诺 Cloud 圆圈的外观或三秒闲置隐藏规则同样适用于 Connect；Cloud 的圆圈行为按 Cloud 来源单独回归。

同机播放使用 localhost，不随 Wi-Fi 地址变化而需要改 URL。Connect 服务端口修改时，播放器完整链接与 SDK 的服务 origin 分别更新。其它程序或其它电脑的 Connect 服务不能仅凭同端口被当作本机目标；输入地址和播放器链接始终是两份独立配置。

停止 Bridge 只停输入进程；退出 NIO Warp 不代表退出 Connect，不应关闭客户其它 Chrome 页面。服务断线后 Bridge 只重新注册，不重放旧动作；生产者读取当前硬件状态后同步。Connect 不会由本包自动登录、自动导入原型或被全局守护重启。

署名：codex（OpenAI）| 2026-10-10
