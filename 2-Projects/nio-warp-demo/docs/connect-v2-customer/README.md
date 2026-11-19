# NIO Warp V2 客户交付说明

本交付为 **2.0.0-rc.1 候选版（App version 2.0.0、build 78）**。本地自动化与构建记录由交付清单提供；已核对 Connect 2.13 公开静态播放器结构，真实原型/消息闭环、客户套餐、外部输入、屏幕/玻璃效果及持续运行尚未验收。收到文件不会自动替换客户现有 App 或连接客户电脑。

| 交付项 | 作用 | 状态 |
|---|---|---|
| NIO Warp 安装 DMG | 新增同机 Connect 浏览器来源及原生fitToScreen/originalSize；按原固定路径安装 | RC；横向铺满/原型内部取景禁用；App本机ad-hoc未公证，不含客户参数/权限备份 |
| connect-sdk | 独立 Node 输入 Bridge、锁定依赖、消息约定、自动测试 | 本地 2.x/4.x 真实 Socket.IO 服务已测；真实 Connect 未测 |
| 演示原型步骤 | 用合法 Studio 建立 Receive 闭环 | 提供步骤；未生成/未验证真实 `.pie` |
| skill | 客户 AI 输入二开范围和约定 | 可手动加载；不自动安装或授权 |
| rollback | V1.0.0（77）安装 DMG / 软件归档 | 软件包来源和 SHA-256 以交付 manifest 为准；客户当前参数另行本地备份，每台机器单独授权 |

按 [安装与权限](INSTALL.md)、[Connect 设置](CONNECT.md) 操作，再按 [验收记录](ACCEPTANCE.md) 逐项填写。二开读 [开发说明](DEVELOPMENT.md)，故障处理与恢复读 [日志与回退](ROLLBACK.md)。交付 `manifest.json` / SHA-256 清单是包版本、签名、架构、来源提交和已测状态的依据，不使用历史 V1 的现场验收作为 V2 证据。

Connect 2.13 的 Stage/D3 播放器使用独立鼠标基准，本 RC 保留原生 transform，尚未完成 Connect 完整横向铺满或内部取景适配；光标采用原生 `auto` / `none`，不承诺 Cloud 圆圈行为。现有 Cloud 横向铺满和整幅 Warp 物理 Y 调节保持原有行为，仍需分别回归。

每台机器都必须单独授权屏幕录制。Air 曾出现旧开发证书 v28 的开关已开启、ad-hoc V1（77）的捕获预检仍拒绝；精确重置本 App 授权后，用户已重新允许、完全退出重开，并手动确认 V1 实际显示正常。该确认仅属于 V1，不代表 V2 首帧或 Connect 消息/输出链路已验收。精确 `tccutil` 命令与边界见 [安装说明](INSTALL.md)；本包不自动 grant、不全局重置，不把App/DMG当作现场参数或权限备份。

Connect 账户和原型由客户管理。Custom Plugins / Bridge Apps 仅限 Enterprise；Core/Free 不能保证此 SDK 可运行。若客户套餐不含该功能，可评估客户已获授权的内置插件，并重新验收输入链路；本包不绕过授权、不承诺自动登录或全部套餐可用。[官方功能对照](https://www.protopie.io/learn/docs/connect-protopie-connect-pro-vs-enterprise)

署名：codex（OpenAI）| 2026-10-10
