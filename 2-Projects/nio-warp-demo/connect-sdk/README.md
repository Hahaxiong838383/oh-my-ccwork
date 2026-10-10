# NIO Warp 独立输入 SDK 2.0.0-rc.1

状态：RC；SDK 本地自动化已通过，真实 ProtoPie Connect、客户套餐、输入硬件和光学现场尚未验收。

本 SDK 是独立 Node.js Bridge。它把标准输入的一行 JSON 转为 Connect 消息。NIO Warp 继续负责浏览器播放、捕获和校畸变；Bridge 只连接 Connect，接口不包含 Warp 参数、系统快捷键或进程管理。

```text
客户输入程序 → JSON-lines stdin → 本 Bridge → ProtoPie Connect → 原型 Receive
                                                        ↓
                                              浏览器播放器 → NIO Warp
```

## 授权与兼容

自定义插件和 Bridge Apps 是 Connect Enterprise 功能，Connect Core 和 Free 均不包含。安装本 SDK 不产生 Enterprise 授权，不能代替订阅或登录。用户在 Connect 中自行登录、加载原型并确认权限。[官方功能对照](https://www.protopie.io/learn/docs/connect-protopie-connect-pro-vs-enterprise)

默认 `protocol: "legacy2"` 依据 ProtoPie 官方 Bridge 示例的 2.x 客户端；另提供显式 `modern4`。二者不自动切换。当前官方示例无法证明每个 Connect 版本的服务端协议，客户需在空白演示原型上确认目标版本；消息连接成功也不能代替画面验收。[官方 Bridge 示例](https://github.com/ProtoPie/protopie-connect-bridge-apps/blob/badcc7b78bd8853c99baa6f2fbcc4f5bba4e9eae/node-bridge/index.js)、[Socket.IO 兼容表](https://socket.io/docs/v4/client-installation/#version-compatibility)

| 模式 | 锁定客户端 | 本地测试服务端 | 使用边界 |
|---|---|---|---|
| legacy2（默认） | 2.5.0 | 2.5.1 | 仅 localhost、127.0.0.1、[::1]；旧依赖有已知中危问题 |
| modern4 | 4.8.4 | 4.8.4 | 明确支持 3/4.x 协议；目标 Connect 需确认 |

旧依赖的审计和使用条件见 [DEPENDENCY-REVIEW.md](DEPENDENCY-REVIEW.md)。SDK 只使用 WebSocket transport；不会把协议不兼容当作输入命令自动补发，也不提供连接口令或 TLS 校验绕过选项。

## 运行

需要 Node.js 22+，推荐经官方核验的 Node.js 24 LTS；本次测试使用 24.19.0。[Node.js 发布状态](https://nodejs.org/en/about/previous-releases)

在解压后的 `connect-sdk` 目录执行，仅安装此目录依赖：

```sh
npm ci --ignore-scripts --omit=dev
cp config.example.json config.local.json
node src/cli.js --config config.local.json
```

打开 Connect 并加载演示原型，等待终端出现 `"event":"connected"`，再逐行输入下面的内容，每行回车，间隔至少 100ms：

```jsonl
{"type":"status"}
{"messageId":"demo.level","value":25}
{"messageId":"demo.level","value":75}
{"messageId":"demo.toggle","value":1}
{"messageId":"demo.action","value":"next"}
{"messageId":"demo.action","value":"reset"}
```

stdout 返回一行结果，stderr 是脱敏状态日志。`submitted` 仅表示已提交到本地传输层；无 ACK，不保证 Connect 或原型收到。modern4 的 volatile 发送在传输忙时也可能丢弃，生产者应重新读取当前状态并按约定发送。EOF 会停止 Bridge（为已经提交的写入留 100ms），Ctrl+C 也会停止。不要启动时立即 `cat` 整份命令文件：连接完成前的输入会被丢弃。

`offline`、`invalid`、`transport_busy`、`rate_limited`、`duplicate`、`debounced` 都代表丢弃，不加入等待队列。注册或传输忙时 `transport_busy` 不会记住该状态，下一采样周期可重试当前状态；同值状态在一秒窗口内去重，一秒后可由生产者主动刷新。断线后不重放旧命令；复连记录 `stateSyncRequired: true`，输入程序重新读取当前硬件状态，按发送频率同步当前 `demo.level` / `demo.toggle`，动作必须由新事件触发。详见 [消息约定](MESSAGE-PROTOCOL.md)。

## 配置与开发

`serverURL` 是服务 origin，如 `http://localhost:9981`；不是 `/pie?...` 播放器链接。只接受 HTTP/HTTPS、根路径、无用户名密码、无查询和片段。服务器端口可改。`protocol` 只接受 `legacy2` / `modern4`，切换后重启 Bridge。`maxHz` 为全局上限（1–200，默认 20），连接超时 100–30000ms；自动重连最多 0–20 次（默认 10），初始间隔 100–10000ms（默认 1000）。未知配置字段拒绝加载。

可把 `logDirectory` 改为 SDK 下的 `./logs`，默认不写文件；启用后只保存状态、版本、会话、配置哈希和计数，单文件最多 1MiB，最多保留当前加两个旧文件。日志不保存完整 URL、配置路径、输入值、订阅密码、原型或校正参数。文件日志失败后停止文件写入并报告 `log_file_disabled`，不会把系统异常原文输出。日志不自动上传；分享前仍由客户自行检查。

二开入口是 `src/protocol.js` 的消息验证，以及客户新建的输入适配程序。适配程序将串口、USB 或业务 API 转为 JSON-lines，或调用 `createBridge`；不要修改 NIO Warp。可参考 [原型制作步骤](examples/MAKE-DEMO.md)、[客户开发说明](../docs/connect-v2-customer/DEVELOPMENT.md) 和 [AI 二开 Skill](skill/nio-connect-input/SKILL.md)。

## 验证

```sh
npm ci --ignore-scripts
npm test
npm audit --omit=dev
```

`npm test` 在随机 loopback 端口启动真正的 2.x/4.x Socket.IO 服务，验证注册和官方 payload、错误值拒绝、限速/去抖、忙时不排队、当前状态刷新、断线复连不重放、协议不匹配、实际 CLI、字节行长度上限和脱敏日志轮转。测试不连接客户设备或真实 Connect。2026-10-10 记录：13/13 通过；生产审计 3 中危、全量审计 4 低危+4 中危，详见审计说明。真实 Connect 和现场项目保持未验收。

署名：codex（OpenAI）| 2026-10-10
