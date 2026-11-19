---
name: nio-connect-input
description: 为 NIO Warp 客户扩展独立的 ProtoPie Connect 输入 Bridge、JSON-lines 适配和原型消息；适用于串口、USB 或业务输入二开，不用于修改 Warp 校畸变核心。
---

# 独立输入二开

目标是把客户输入送到已授权的 ProtoPie Connect，再由原型 Receive 改变画面。此 Skill 随 SDK 交付，可由客户 AI 加载；加载它不安装依赖、不修改全局 Agent 配置、不授权登录或远程部署。

先定位本 Skill 上两级的 SDK 目录，读取 [README](../../README.md) 和 [消息约定](../../MESSAGE-PROTOCOL.md)。用本地可写副本开发，运行时设置留在已忽略的 `config.local.json`。输入适配放在 SDK 下新模块，消息白名单/值验证放在 `src/protocol.js`，原型制作按 [步骤](../../examples/MAKE-DEMO.md)。

范围限于独立 Bridge、输入适配、消息文档和对应原型。不要修改 NIO Warp App、几何/镜像/AA/鼠标参数、客户预设或偏好文件，也不要将输入故障转换为系统快捷键、全局进程清理或 Connect 自动重启。用户明确要求修改 Warp 核心时，将其作为另一个需单独评估的任务，不借本 Skill 扩大当前二开范围。

新增消息前写清名称、值类型/单位、范围、频率、去抖、初始值、断线与复连行为，并在原型配置完全同名的 Receive。标准输入一行只传 `messageId` 与 `value`；不要加入密码、完整播放器 URL、Warp 参数或未约定的字段。

Connect Custom Plugins / Bridge Apps 需要 Enterprise，Core/Free 不包含。由客户自行登录和确认套餐；不索取订阅密码。`legacy2` 是官方旧示例对应模式，仅限 loopback，有已知旧依赖风险；`modern4` 需确认目标服务协议。协议显式选择，不盲切、不把兼容测试动作发向业务原型。未取得真实 Connect / Studio 合法可用环境时，交付制作步骤并标未验收，禁止伪造 `.pie`。

连接前/断线时输入直接丢弃，不缓存动作；复连时生产者重新读取当前硬件状态，再按上限同步当前状态。`submitted` 不等于送达，connected 不等于原型可用。需要业务确认时另定义应用层确认及超时契约，避免补发非幂等历史动作。

依赖只在 SDK 目录用 `npm ci --ignore-scripts` 安装；不全局安装、不未经验证升级主协议版本。验收新增消息时使用仓库已有的真实 2.x/4.x loopback 测试模式，检查 payload、非法值、频率、断线复连不重放；运行 `npm test` 和 `npm audit --omit=dev`。读取 [依赖审计](../../DEPENDENCY-REVIEW.md) 后披露残余问题，不能把已知中危写成“无漏洞”。

客户设备部署和收集日志按客户明确授权执行；普通代码二开不赋予远程登录权限。日志仅状态、计数、版本和配置哈希，不记录输入值或校正原件，不自动上传。最终报告分别列代码/本地服务测试、真实 Connect 测试和现场硬件测试，未做的明确标未验收，并给出停止 Bridge / 恢复旧 SDK 副本的回退方法。
