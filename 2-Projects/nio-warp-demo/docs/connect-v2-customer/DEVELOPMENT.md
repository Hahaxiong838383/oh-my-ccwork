# 客户输入二开

状态：2.0.0-rc.1；输入 SDK 可独立开发，真实硬件和 Connect 待客户验收。

先读交付目录 `connect-sdk/README.md`、`MESSAGE-PROTOCOL.md`、`DEPENDENCY-REVIEW.md`。客户从 SDK 的可写副本新增适配程序，将输入协议解析成一行一个 JSON 对象；stdin 采用管道时生产者要保持进程运行，并先等 Bridge 的 connected，再发输入。终端/程序必须分别处理 stdout 的结果与 stderr 的状态日志。EOF 会关闭 Bridge；中断会丢弃未提交输入，不补发。

| 开发位置 | 内容 |
|---|---|
| SDK 下客户新增模块 | USB/串口/业务 API 读取、输入去抖、类型转换、当前状态同步 |
| `src/protocol.js` | 新消息名称及值验证白名单 |
| `MESSAGE-PROTOCOL.md` | 类型、单位、范围、频率、初始/断线/复连契约 |
| 客户合法 Studio 原型 | 对应 Receive / 变量 / 图层响应 |
| `test/` | 真正本地 Socket.IO 服务的消息与故障测试 |

输入接口不提供校畸变核心二开。不要修改 App 二进制、原有 Swift/Metal 核心、几何、AA、镜像、鼠标方向或现场预设；不把未知输入变成系统快捷键。客户调试原型时可以使用原型自己的消息，不把 `reset` 当作 Warp 复位。

## 模块调用

适配程序也可在同一独立 Node 进程调用 Bridge：

```js
import { createBridge } from './src/bridge.js';
const bridge = createBridge({ protocol: 'legacy2', serverURL: 'http://localhost:9981' });
bridge.on('state', status => {
  // connected 后读取真实当前输入，并按 maxHz 分开发状态。
  // 不从上一次断线会话取历史 action 重新发送。
  console.error(JSON.stringify({ state: status.state }));
});
bridge.start();
// 只在你的真实输入回调中调用，下面是 API 形式示例：
// const result = bridge.send({ messageId: 'demo.level', value: currentLevel });
process.on('SIGINT', () => bridge.stop());
```

仅 `start`、`stop`、`send`、`status` 和 `state` 事件属于 SDK 的扩展 API；不向适配代码提供内部 Socket 对象。默认 20Hz 为全局立即丢弃上限，同步两个状态至少分开 50ms。`stateSyncRequired` 是提示，需生产者重新读取当前输入；它不是 ACK，SDK 不替生产者存储离线队列。

## 新消息验收

新增消息必须有确定类型、单位、上下限、频率、去抖和复连行为，拒绝未约定的值。写测试时启动真实 loopback Socket.IO 服务，断开后恢复同一端口，确认旧动作未出现，再发新的当前状态。使用 `npm ci --ignore-scripts` 安装测试依赖，运行 `npm test` 和 `npm audit --omit=dev`；不要全局安装或未经兼容验证执行 `audit fix --force`。

只在空白演示原型上确认协议和 Receive；Connect 面板看到消息、浏览器变化、Warp 捕获输出是三个检查点。真实 `.pie` 必须由客户合法可用的 Studio 保存，并记录实际文件哈希；没有授权时交付制作说明，不伪造后缀文件。

可让客户 AI 手动加载 `connect-sdk/skill/nio-connect-input/SKILL.md`。该 Skill 自包含、只指导独立输入扩展；不自动安装到客户全局目录、不赋予远程部署或读取现场参数的权限。二开版本在客户副本独立标记并保存依赖锁、测试和验收记录；正式 App 更新仍走原交付流程。

署名：codex（OpenAI）| 2026-10-10
