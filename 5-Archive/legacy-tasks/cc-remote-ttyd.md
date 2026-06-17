> 归档自 tasks/，日期 2026-06-17（不再活跃）

# cc-remote：基于 ttyd 的多 CLI 远程终端平台

> 在公网通过 Web 页面远程操作 macmini/macbook/Windows 上的 Claude Code、Codex、Gemini CLI

## 需求

- 3 个 CLI（claude、codex、gemini）各自独立终端
- PC 浏览器 + 手机浏览器全平台访问
- CLI 原生功能完整保留：MCP、Skill、命令、交互式 UI
- 多 Session：同一 CLI 可开多个会话，并行任务
- 多设备管理：macmini、macbook、Windows 可切换
- 安全：登录认证

## 技术选型

| 组件 | 选择 | 理由 |
|------|------|------|
| 终端后端 | **ttyd** | 成熟稳定，原生 xterm.js + PTY，★8k+，零维护 |
| 反代 + 认证 | **Caddy** | 自动 HTTPS，配置简洁，内置 basicauth |
| 公网穿透 | **Cloudflare Named Tunnel** | 固定域名，免费，已有配置 |
| 管理面板 | **静态 HTML** | 轻量，设备/会话管理，无需框架 |
| 进程管理 | **pm2** 或 **launchd** | 守护 ttyd + caddy 进程 |

## 架构

```
手机/电脑浏览器
    ↓ HTTPS
cli.hahaxiong.top (Cloudflare Named Tunnel)
    ↓ localhost:8443
Caddy (反代 + basicauth 认证)
    ├─ /                    → 管理面板 (静态 HTML)
    ├─ /claude/{session-id} → ttyd (claude CLI)
    ├─ /codex/{session-id}  → ttyd (codex CLI)
    ├─ /gemini/{session-id} → ttyd (gemini CLI)
    └─ /api/                → 管理 API (Node.js 轻量服务)
        ├─ POST /api/session     创建会话
        ├─ DELETE /api/session/x 销毁会话
        ├─ GET /api/sessions     列出会话
        └─ GET /api/devices      列出设备
```

### 多 Session 实现

每个 session = 独立 ttyd 进程 + 独立端口：
```
Session 1: ttyd -p 7001 claude       → Caddy /claude/s1 → localhost:7001
Session 2: ttyd -p 7002 claude       → Caddy /claude/s2 → localhost:7002
Session 3: ttyd -p 7003 codex        → Caddy /codex/s3  → localhost:7003
```

管理 API 负责：分配端口 → 启动 ttyd → 注册路由 → 返回 URL

### 多设备实现

```yaml
# devices.yaml
devices:
  macmini:
    host: cli.hahaxiong.top
    tunnel: Named Tunnel (本机)
    clis: [claude, codex, gemini]
  macbook:
    host: macbook.hahaxiong.top
    tunnel: 另一个 Named Tunnel
    clis: [claude, codex, gemini]
  windows:
    host: win.hahaxiong.top
    tunnel: cloudflared on Windows
    clis: [claude, codex]
```

管理面板通过切换 host 来访问不同设备。每台设备独立部署 ttyd + Caddy + Named Tunnel。

## 实施计划

### Phase 1：单机 macmini（预计 30min）

**目标**：在 macmini 上跑起来，手机能访问 claude/codex/gemini

1. 安装 ttyd + Caddy
   ```bash
   brew install ttyd caddy
   ```

2. 配置 Caddy（Caddyfile）
   ```
   :8443 {
     basicauth /* {
       admin $2a$14$... (bcrypt hash)
     }

     # 管理面板
     handle / {
       root * /path/to/panel
       file_server
     }

     # ttyd 反代（动态端口）
     handle /claude/* {
       reverse_proxy localhost:7001
     }
     handle /codex/* {
       reverse_proxy localhost:7002
     }
     handle /gemini/* {
       reverse_proxy localhost:7003
     }

     # 管理 API
     handle /api/* {
       reverse_proxy localhost:7100
     }
   }
   ```

3. 启动 ttyd 实例
   ```bash
   ttyd -p 7001 -W claude    # -W 允许写入
   ttyd -p 7002 -W codex
   ttyd -p 7003 -W gemini
   ```

4. Named Tunnel 指向 Caddy
   ```bash
   cloudflared tunnel run --token $CF_TUNNEL_TOKEN
   # ingress: cli.hahaxiong.top → localhost:8443
   ```

5. 验证：手机访问 https://cli.hahaxiong.top/claude/

### Phase 2：管理面板 + 多 Session（预计 2h）

**目标**：Web 面板管理会话，支持同一 CLI 开多个 tab

1. 静态管理面板（HTML + JS）
   - 设备选择器（下拉菜单）
   - CLI 启动按钮（claude / codex / gemini）
   - 活跃会话列表（可关闭）
   - 每个会话用 iframe 嵌入 ttyd 页面

2. 管理 API（Node.js 轻量服务）
   - 端口池管理（7001-7099）
   - ttyd 进程生命周期
   - Caddy 动态路由（API 热更新）
   - 会话超时自动回收

3. 移动端适配
   - 响应式布局
   - 触摸键盘优化

### Phase 3：多设备（预计 1h/台）

**目标**：macbook、Windows 也能远程访问

每台设备重复 Phase 1 的部署：
1. 安装 ttyd + Caddy + cloudflared
2. 创建 Named Tunnel + DNS 记录
3. 管理面板注册新设备

## V2RayN 注意事项

- **必须关闭 TUN 模式**（或添加 Cloudflare Edge IP 直连规则）
- 仅使用系统代理模式
- cloudflared 子进程需设置 `HTTPS_PROXY=""` 绕过系统代理

## 与现有 mycc 的关系

- cc-remote 是独立项目，**不修改 mycc 代码**
- mycc 的飞书通道、定时任务等功能不受影响
- 两者可共用同一个 Named Tunnel（Caddy 按路径分流）
- 或使用独立子域名（推荐：terminal.hahaxiong.top）

## 文件结构

```
2-Projects/cc-remote/
├── Caddyfile              # Caddy 配置
├── devices.yaml           # 设备配置
├── panel/                 # 管理面板
│   ├── index.html
│   ├── style.css
│   └── app.js
├── api/                   # 管理 API
│   ├── server.ts
│   ├── session-manager.ts
│   └── port-pool.ts
├── scripts/
│   ├── start.sh           # 一键启动
│   ├── stop.sh            # 一键停止
│   └── install.sh         # 首次安装
└── README.md
```

## 状态

- [x] Phase 1：单机 macmini（2026-03-15 完成）
- [x] Phase 2：管理面板 + 多 Session + tmux 持久化 + 进程守护（2026-03-16 完成）
- [x] Phase 3：多设备 UI + 断线重连 + 日志轮转（2026-03-16 完成）
- [ ] Phase 4：macbook/Windows 实际部署（等需要时执行）
