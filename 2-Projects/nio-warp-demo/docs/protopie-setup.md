# nio-war-mac：ProtoPie 人工与 AI 操作

## 2026-09-07 安装结果

- 已安装并启动 `/Applications/ProtoPie.app`，版本 **10.4.0 Universal**，设备为 Apple M5 Pro / macOS 26.5.1。
- 安装来源：官网 `https://download.protopie.io/universal/latest`，本轮重定向到 `https://release.protopie.io/ProtoPie-10.4.0-universal.dmg`。
- 安装包 SHA-256：`f9455dad7a5477f51e220f2c81274616bd2704d3630bdce446f1f4c5cf3dd6d8`。
- `codesign --verify --deep --strict` 通过；签名 Studio XID, Inc，Team ID `24V7JB28L6`；Gatekeeper 返回 accepted / Notarized Developer ID。

## 人工使用

在 nio-war-mac 的“应用程序”中打开 ProtoPie。首次使用需登录自己的 ProtoPie 账号；本轮未代建账号、未购买套餐、未验证账号权益。

## AI 使用

采用官方 **Studio MCP**，操作当前打开且获得焦点的原型，可以读取内容、编辑交互及捕获预览。Code MCP 仅供从云端原型读取并生成代码，不能代替 Studio MCP 编辑本机原型。

Studio 主机已注册 Codex MCP：

```text
名称：protopie-nio-war-mac
URL：http://127.0.0.1:19982/mcp
```

Studio 用户 LaunchAgent `~/Library/LaunchAgents/io.nio-war-mac.protopie-tunnel.plist` 已加载，登录时自动运行并在断线后重连：

```text
Studio 127.0.0.1:19982 → SSH nio-war-mac（雷电）→ nio-war-mac 127.0.0.1:9982
```

ProtoPie 自身监听 `*:9982`；客户端使用上述隧道入口。未将端口映射到公网。日后若 Labs 显示其他端口，必须同步更新隧道，不能只改 Codex URL。

## 仍需完成的首次操作

1. 在 nio-war-mac 登录 ProtoPie，打开或新建一个测试原型。
2. Preferences → Labs → 打开 **MCP Server**，核对显示端口为 9982。
3. 重新连接 Codex MCP，ProtoPie 弹出连接请求时点击 **Allow**。
4. 通过 MCP 读取场景、在测试原型添加一条交互并回读，完成实际编辑验收。当前 Codex 任务未动态加载新注册工具时，需重新打开任务。

19:39 实测：通过雷电隧道发送 MCP initialize，收到应用明确响应 `MCP server is disabled. Enable it in Preferences > Labs.`。这证明服务路径可达，但 **MCP 尚未启用，AI 实际读写尚未验收**。未绕过应用授权。

官方文档：https://www.protopie.io/learn/docs/mcp-studio-mcp-setup

## 撤销 AI 接入

在 Studio 运行：

```bash
codex mcp remove protopie-nio-war-mac
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/io.nio-war-mac.protopie-tunnel.plist
```

并在 ProtoPie Preferences → Labs 关闭 MCP Server。应用仍可人工使用。

署名：codex（OpenAI）| 2026-09-07 19:39 CST

## 2026-09-08 状态更新

用户已完成 ProtoPie 登录。远程登录服务重开后 SSH 与隧道恢复；15:57 再次 initialize 仍返回 MCP server is disabled。仍需 Preferences → Labs 开启 MCP、首次 Allow，以及原型读写验证；登录成功不等于 MCP 已启用。
