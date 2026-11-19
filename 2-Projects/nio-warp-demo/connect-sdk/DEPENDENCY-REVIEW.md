# 锁定依赖与审计（2026-10-10，RC）

依赖来自 npm 官方 registry，仅安装在 `connect-sdk/node_modules`，使用 `package-lock.json` 固定解析结果。SDK 要求 Node.js 22+，本地测试为 Node 24.19.0 / npm 11.17.0 / macOS 26.4.1 arm64。

| npm 别名 | 实际包/版本 | 分类 |
|---|---|---|
| socket.io-client-legacy | socket.io-client 2.5.0 | 运行依赖；2.x 当前可用最新版本 |
| socket.io-client-modern | socket.io-client 4.8.4 | 运行依赖；当前官方最新版本 |
| socket.io-server-legacy | socket.io 2.5.1 | 仅本地测试依赖 |
| socket.io-server-modern | socket.io 4.8.4 | 仅本地测试依赖 |

版本由 `npm view` 与实际 `npm ls --depth=0` 核对，4.8.4 同时与 [Socket.IO 官方安装说明](https://socket.io/docs/v4/client-installation/) 对照。旧模式依据 [ProtoPie 官方示例依赖](https://github.com/ProtoPie/protopie-connect-bridge-apps/blob/badcc7b78bd8853c99baa6f2fbcc4f5bba4e9eae/node-bridge/package.json)，此示例使用 `^2.3.0`，不能作为新 Connect 服务端版本证明。

## 审计结果与处置

执行 `npm audit --json`：8 个受影响依赖项，4 低危、4 中危、0 高危、0 严重。执行 `npm audit --omit=dev --json`：3 个受影响依赖项，均中危，0 高危/严重。受影响依赖项含传播链，不等于 8 个独立漏洞；原始结果保存在 `verification/`。

| 来源 | 公告 | 影响与本包限制 |
|---|---|---|
| parseuri `<2.0.0` | [GHSA-6fx8-h7jm-663j](https://github.com/advisories/GHSA-6fx8-h7jm-663j) | URL 解析 ReDoS；生产旧客户端及 engine.io-client 受影响。本 SDK 在创建客户端前用内置 URL 解析并限制长度、origin 形式；legacy2 只允许 loopback，不接受命令输入改变服务地址 |
| debug 4.1.1 | [GHSA-gxpj-cx7g-858c](https://github.com/advisories/GHSA-gxpj-cx7g-858c) | 正则 ReDoS；位于旧测试服务端依赖链。测试服务只绑定随机 loopback 端口；生产用 `--omit=dev` 排除 |
| cookie `<0.7.0` | [GHSA-pxg6-pf52-xh8x](https://github.com/advisories/GHSA-pxg6-pf52-xh8x) | cookie 属性验证问题；位于旧测试服务端链，生产排除 |

以上限制减少暴露，不代表修复旧包。RC 暂保留 legacy2 以验证官方旧协议，使用条件是本机受控输入和可信本机 Connect；不得将旧模式接入外网或在此目录运行对外 Socket.IO 服务。本地测试 server 不作为交付业务服务启动。拒绝已知旧依赖的企业环境应停用此 SDK，先确认真实 Connect 是否支持 modern4，再另做依赖裁剪和复验；仅把配置改为 modern4 不会移除 package-lock 中的 legacy 包。

不运行 `npm audit fix --force`，它可能把旧链提升到不兼容的协议版本。未强制覆盖旧包的跨主版本传递依赖；后续更新须重新验证两套真实服务与目标 Connect。审计状态随 registry 公告变化，应在正式交付前再执行一次并保留新结果。

本次仅验证依赖加载和 loopback 消息行为，真实 Connect 的版本兼容、账号授权、硬件和现场未验证。只允许明确选定协议的重连，不自动尝试不同协议并发送动作。

署名：codex（OpenAI）| 2026-10-10
