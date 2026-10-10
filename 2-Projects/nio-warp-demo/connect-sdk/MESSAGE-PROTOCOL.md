# 输入消息约定 v1（2.0.0-rc.1）

状态：RC；本地 Socket.IO 2/4 服务已验证；目标 Connect 和原型未验证。

## 传输层与官方依据

连接默认 Socket.IO 根 namespace `/`，默认路径 `/socket.io/`，服务 origin 默认 `http://localhost:9981`。首版只使用 WebSocket transport；Socket.IO 不是裸 WebSocket。每次连接/复连时注册：事件名 `ppBridgeApp`，payload `{"name":"NIO Input Bridge"}`。输入事件名 `ppMessage`，payload 为下面三个字段：

```json
{"messageId":"demo.level","value":50,"fromName":"NIO Input Bridge"}
```

字段和事件名依据 [ProtoPie 官方 Node Bridge 示例](https://github.com/ProtoPie/protopie-connect-bridge-apps/blob/badcc7b78bd8853c99baa6f2fbcc4f5bba4e9eae/node-bridge/index.js)，`messageId` / `value` 的用途依据 [官方 Custom Plugins 文档](https://www.protopie.io/learn/docs/connect-custom-plugins)。本 SDK 没有实现官方未定义的 ACK、pieid 定向路由、登录、原型上传或 Warp 写接口。消息可被 Connect 中监听同名消息的多个原型消费；验收时只保留演示原型，业务原型使用独立消息命名空间。

Bridge 的标准输入不是 Socket.IO 原始包。每行只接受两个字段 `messageId` 和 `value`，不得传 `fromName` 或其它字段；Bridge 填写已配置的名称。一行 UTF-8 数据最多 8192 字节，支持 CRLF，空行忽略；非法 JSON / 超长行丢弃并继续读下一行。状态请求例外：单字段 `{"type":"status"}`，只在本地输出状态。

## 演示契约

| 消息名 | 值与单位 | 范围/初始值 | 频率及去抖 | 断线/复连 |
|---|---|---|---|---|
| `demo.level` | JSON number，百分比 | 0–100；原型初始 0 | 默认全局最多 20Hz；相同已提交值一秒内丢弃，一秒后可主动刷新 | 断线保持原型最后显示；复连重新读取硬件当前值再发 |
| `demo.toggle` | JSON number，开关状态 | 0 / 1；原型初始 0 | 同上；同值一秒内丢弃 | 同上；复连按当前开关值同步 |
| `demo.action` | JSON string，动作 | `next` / `reset`；初始不触发 | 同上；相同动作 100ms 内去抖 | 不缓存、不重放；仅新动作事件可发送 |

数值字符串、布尔值、NaN/Infinity、未知消息均拒绝。SDK 不发送默认初始值，也不强制重置现场原型。原型初始状态由作者设定，恢复状态由输入生产者读取真实当前输入后同步。断线时如果业务需要显示“连接丢失”，需在原型和扩展层另定义心跳/超时消息并完成验收；当前 SDK 未实现心跳和原型断线视觉提示。

限速采用立即丢弃，不等待、不合并或排队。三类消息共享 `maxHz`，成功本地提交之间至少 `1000/maxHz` 毫秒；状态同步至少间隔该时间。注册和传输层忙时返回 `transport_busy` 并且不记住该输入。被限速/忙时丢弃的当前状态可在下一输入采样周期重发；主动每秒刷新也必须重新采样当前值，不取历史队列。历史动作不补发。`next` 用于演示计数加一；`reset` 用于演示计数归零，不是 Warp 参数重置。

## 交付语义

`connected` 仅指 Socket.IO namespace 已连接，不表示账号授权、原型 loaded、Receive 收到消息或画面被捕获。`submitted` 是本地提交结果，采用至多一次的业务语义；没有确认与自动重试，网络中断可丢失正在发送的事件。两个模式都在 connected 且传输 writable 时才提交；modern4 使用 volatile 事件，legacy2 在状态变更时清空客户端离线队列。实现不暴露 Socket 对象给输入适配代码；writable 检查依赖锁定的 Engine.IO 实现，更新依赖时必须复跑注册忙时的真实服务测试。[Socket.IO 官方离线发送说明](https://socket.io/docs/v4/client-offline-behavior/)

SDK 状态为 `stopped` / `connecting` / `connected` / `disconnected` / `exhausted`。暂时中断按有界次数重连；服务端主动断开不会自动重连，协议不匹配不切换版本；检查版本/权限后人工重启。复连仅重新注册 Bridge，不重发旧命令。`stateSyncRequired` 在 connected 状态提示生产者可能需要同步当前状态；它不是接收确认，也不在业务状态提交后自动变为 false。

扩展新消息时同时更新验证器、类型/单位、范围、频率、去抖、初始/断线/复连行为、原型 Receive 和真实服务测试。涉及几何、镜像、AA、鼠标方向或系统快捷键的命令不属于本接口。

署名：codex（OpenAI）| 2026-10-10
