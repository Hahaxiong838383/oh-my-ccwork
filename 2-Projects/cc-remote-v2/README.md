# cc-remote-v2（AI CLI Web 远程终端 · 第 2 版）

> 状态：archived（推断依据：同级存在 cc-remote-v3 / cc-remote-v4，v4 已配套 `cc-remote-deploy` skill 做多用户部署且更新到 2026-04；v2 全部文件停留在 2026-03-23 未再改动，已被后续版本取代）
> 最后活跃日期：2026-03-23（目录内所有文件均为该日，最新 = vite.config.js / tunnel-client.js 等）
> 一句话目标：用浏览器远程访问本机的 AI CLI（Claude Code / Codex / Gemini CLI），基于 Express + WebSocket + node-pty + tmux，支持移动端操作与公网隧道。

## 下一步
- [ ] 无需推进（已被 cc-remote-v3 / v4 取代）。如需历史参考再查阅，否则建议迁入 `5-Archive/`。

## 归档条件
- 已满足归档条件：被 cc-remote-v3 / cc-remote-v4 取代，代码 3 个月未改动。可随时移入 `5-Archive/`（迁移与否待川哥确认）。

## 当前事实
- 技术栈：Express 5 + ws（WebSocket）+ node-pty + tmux（`/opt/homebrew/bin/tmux`），前端 Vite 8 + @xterm/xterm 5.5（来源：package.json、session-manager.js 已验证）。
- 会话模型：每个 session 对应一个独立 tmux session（命名 `ccr-<engine>-<id>`）；pty 惰性创建，WebSocket 断开释放 pty 但 tmux 持久化，重连重新 attach（来源：session-manager.js 已验证）。
- 支持引擎：claude（Claude Code）/ codex（Codex CLI）/ gemini（Gemini CLI），运行时用 `which` 探测可用性（来源：session-manager.js 已验证）。
- 默认工作目录：`$WORK_DIR` 或 `~/mycc`（来源：session-manager.js 已验证）。
- 安全机制：可选 `CC_REMOTE_TOKEN`（WS 连接需带 `?token=`）+ 可选 `CC_REMOTE_ORIGINS`（Origin 白名单），本地开发默认全放行（来源：server.js 已验证）。
- 公网暴露：通过 tunnel-client.js 连接 Relay Server（默认 `https://relay.hahaxiong.cc`）做 HTTP/SSE/WS 隧道穿透（来源：tunnel-client.js 已验证）。
- 客户端特性：移动端触摸滚动 + 快捷键栏、文件上传（≤50MB）/拖拽/粘贴图片、终端搜索、字体缩放、延迟监测、断线自动重连（来源：index.html、src/main.js 已验证）。
- 启动入口缺失项：暂未在本目录发现 server 侧守护/启动脚本（如 start.sh / watchdog.sh），同级 cc-remote 旧版有这些脚本——v2 是否依赖外部脚本启动，待川哥确认。
- Node 版本：要求 >=20，`.nvmrc` 锁定 20（来源：package.json、.nvmrc 已验证；注意二者一致）。

## 关键入口
| 入口 | 路径/链接 | 说明 |
|------|-----------|------|
| 后端服务 | `/Users/rayman.chen/mycc/2-Projects/cc-remote-v2/server.js` | Express + WS 主服务，REST API + WebSocket |
| 会话管理 | `/Users/rayman.chen/mycc/2-Projects/cc-remote-v2/session-manager.js` | tmux + node-pty 会话生命周期管理 |
| 隧道客户端 | `/Users/rayman.chen/mycc/2-Projects/cc-remote-v2/tunnel-client.js` | 经 Relay 暴露到公网（`node tunnel-client.js`） |
| 前端主逻辑 | `/Users/rayman.chen/mycc/2-Projects/cc-remote-v2/src/main.js` | xterm 终端 + 会话切换 + 上传/搜索 |
| 前端页面 | `/Users/rayman.chen/mycc/2-Projects/cc-remote-v2/index.html` | 单页 UI 骨架 |
| 构建配置 | `/Users/rayman.chen/mycc/2-Projects/cc-remote-v2/vite.config.js` | Vite 构建 + dev 代理到 7681 |
| 启动命令 | `npm start`（=`node server.js`）/ `npm run dev`（Vite） | 来源：package.json scripts |

## 外部信息
| 类型 | 值 |
|------|----|
| 外部 repo | 无（mycc 单仓子目录，无独立 GitHub repo） |
| 服务地址 | 本地 `http://0.0.0.0:7681`；公网经 Relay `https://relay.hahaxiong.cc/api/<token>`（来源：server.js、tunnel-client.js 已验证） |
| 端口 | 7681（`PORT` 环境变量可覆盖，来源：server.js / vite.config.js / tunnel-client.js 已验证） |
| 负责人 | 川哥（自有项目） |

## 进度记录
- 2026-06-17：基于本地内容生成项目状态卡（cc）。
