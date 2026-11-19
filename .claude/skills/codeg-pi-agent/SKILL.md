---
name: codeg-pi-agent
description: Codeg 里 Pi 安装失败、toast 只有「pi 安装失败」、会话停在 Connecting、npm EACCES，或本机 pi 启动崩溃时使用。包括公司 Mac Studio 的 Codeg、pi-acp 与 pi-coding-agent。
---

# Codeg Pi 智能体

适配器装上不等于运行时能启动。`agents` 里 installed 为 yes，以及安装接口 HTTP 200，都只说明前半段。完成判据是：用 **Codeg 服务进程的 PATH** 跑通 `pi`，并且 `pi-acp` 的 `session/new` 返回会话。

## 定位实例

公司 Studio 数据目录是 `~/Library/Application Support/Codeg-company-studio`。CLI 端点在该目录 `cli/endpoint-<pid>.json`（url、pid、version）。Web UI 与 CLI API 端口不同，token 也不同。

Web 的 `POST /api/<command>` 使用服务进程环境里的 `CODEG_TOKEN`。CLI endpoint 文件里的 bearer 打到 Web 端口会 401 `Invalid or missing token`。未加 `/api` 前缀的 POST 在 Web 端口是 405。字段用 camelCase（`agentType`、`taskId`、`command`）。

取 token 只从该进程环境读取，过滤后使用。不要打印 token，不要放进 argv、URL 或文档。认证其余规则见 secrets-vault-ops，不要为了读 token 去 sudo Keychain。

## 两段安装

| 段 | 包 | Codeg 怎么看 |
|---|---|---|
| 适配器 | `pi-acp`（registry id `pi-acp`，slug `pi`） | 存在即 installed |
| 运行时 | `@earendil-works/pi-coding-agent`，bin 名 `pi` | 会话要 PATH 上的 `pi` |

Codeg 要求 `pi` 不低于 0.81.0，否则报 `Pi is too old for this version of Codeg`。找不到时报 `Pi is not installed. Install it with: npm install -g @earendil-works/pi-coding-agent`。已装包的 Node 要求读它的 `package.json` `engines`；1.5.2 是 `>=22.19.0`。

安装：`POST /api/acp_install_pi_binary`，body `{taskId}`，前端超时可达 10 分钟。Toast 只有「pi 安装失败」，真错误在 HTTP body。校验：`POST /api/acp_validate_pi_command`，body `{"command":"pi"}`，读 `found`、`resolvedPath`、`version`。

`pi-acp` 对客户端是一行一条 JSON-RPC。`initialize` **不**启动 `pi`。证明能开会话要再发 `session/new`（`cwd` 必须是绝对路径）。成功时结果含 `sessionId`，启动文本含 `pi v`。`pi-acp` 拉起的命令是 `pi --mode rpc`。找不到可执行文件时报 `Could not start pi: executable not found`。

## npm EACCES

body 里是 `EACCES` 且路径在 `~/.npm/_cacache`：缓存里有其他 uid（常见 root）的条目。`sudo -n true` 失败就不要反复 sudo，也不要删整个 `~/.npm`。

把用户 `~/.npmrc` 的 `cache=` 指到可写目录（例如 `~/.npm-cache`），再重试安装。工作区文件工具写不了家目录时用 shell。成功后的 npm debug log 在**新缓存**的 `_logs`。只看 `verbose argv`、`verbose cwd`、`verbose exit`。不要整份打印，日志里可能有其他工具的密钥。

官方安装可能带 `--prefix ~/.codeg/npm-global`。这个 `bin` **不在** Codeg 服务 PATH 上。包若只落在该前缀，校验仍是 `found:false`，会话停在 Connecting。以校验返回的 `resolvedPath` 为准，它必须落在服务 PATH 里。argv 没有 `--prefix` 时，包进 npm 默认全局前缀（Homebrew npm 是 `/opt/homebrew`），该 `bin` 在服务 PATH 上就能用。

## Node

`pi` 的 shebang 是 `#!/usr/bin/env node`，用的是**拉起它的进程的 PATH**，不是当前 shell 的 `node`。先从服务进程环境抽出 PATH（不要打印其余变量），再在该 PATH 下执行 `pi --version`。

Node 22.14.0 上，1.5.2 启动即崩：`TypeError: Cannot read properties of undefined (reading 'bind')`，栈在 undici `decompress.js`（`createZstdDecompress` 不存在）。这不是包没装完。公司 Studio 的服务 PATH 把 `/opt/homebrew/bin` 放在 `/usr/local/bin` 前面时，用的是 Homebrew Node。

## 完成判据

服务 PATH 下 `pi --version` 同时满足 Codeg 最低版本和该包的 `engines`；`acp_validate_pi_command` 的 `resolvedPath` 在这条 PATH 上；`session/new` 返回 `sessionId`。然后告诉用户可以在界面重开 Pi。
