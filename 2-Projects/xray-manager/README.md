# Xray Manager

> 跨平台 Xray 分流代理管理工具。替代 V2RayN，零依赖，单文件 Python Web UI + 系统服务开机自启。
>
> 支持 macOS / Windows / Linux（飞牛 NAS 等）

## 项目背景

川哥在 Windows 和 macOS 两台电脑上使用 V2RayN + 自定义分流配置（Google 系走线路 A，Claude/GPT 走线路 B）。Windows 正常，macOS 出问题。

### 排查过程与发现

| 排查阶段 | 发现 |
|---------|------|
| 1. 端口检测 | 10808 端口无监听 → V2RayN 未加载自定义配置 |
| 2. 进程检测 | **两个 xray 进程同时运行**，抢同一端口 |
| 3. 系统差异 | Windows 端口独占，第二个进程自动退出；**macOS `SO_REUSEPORT` 允许两个进程共存**，流量随机分配导致混乱 |
| 4. V2RayN 行为 | 「自定义配置服务器」功能会被 V2RayN 阉割：**只提取第一个 outbound，丢弃多出站分流** |
| 5. geo 文件 | xray 从 `bin/xray/` 子目录启动，找不到上一层 `bin/` 目录的 `geoip.dat`/`geosite.dat`，导致分流规则加载失败 |

### 根本原因

**V2RayN macOS 版不支持多出站分流配置。** 即使导入完整的自定义 JSON 配置，V2RayN 也会阉割成单出站 + 默认路由。

### 解决方案

不用 V2RayN，直接用 xray-core + 系统服务 + Python Web UI 管理。

## 文件结构

```
2-Projects/xray-manager/
├── xray-manager.py              # Web UI 管理工具（Python 单文件，零依赖）
├── install.sh                   # macOS 一键安装
├── install.bat                  # Windows 一键安装
├── install-linux.sh             # Linux 一键安装
├── package.sh                   # 离线打包脚本（macOS/Windows/Linux）
├── config/
│   └── config.json              # 分流配置模板
├── service/
│   ├── com.xray.proxy.plist     # macOS launchd 服务模板
│   └── xray-proxy.service       # Linux systemd 服务模板
└── README.md
```

## 安装

### macOS

```bash
cd ~/mycc/2-Projects/xray-manager
./install.sh
```

### Windows

```bash
# 双击 install.bat 或在命令行运行（建议管理员权限）
install.bat
```

### Linux（飞牛 NAS 等）

```bash
cd ~/mycc/2-Projects/xray-manager
bash install-linux.sh
```

### 安装脚本自动完成

1. 创建 `~/xray/` 目录
2. 检查/下载 xray 二进制（优先从本地复制，否则从 GitHub 下载）
3. 复制 geoip.dat / geosite.dat
4. 复制分流配置
5. 注册系统服务（macOS: launchd / Windows: Task Scheduler / Linux: systemd user service）
6. 配置代理环境变量（`http_proxy` / `https_proxy` 指向 HTTP 代理端口 20171）
7. 添加 shell 快捷命令

## 端口

| 服务 | 端口 | 用途 |
|------|------|------|
| SOCKS 代理 | 10808 | 系统全局代理（浏览器等） |
| HTTP 代理 | 20171 | CLI 工具代理（Claude Code、npm、curl、git 等） |
| Web 管理 UI | 8888 | 仅本地访问 |

**重要**：`http_proxy` / `https_proxy` 环境变量指向 HTTP 代理端口（20171），不是 SOCKS 端口。大多数 CLI 工具不支持 SOCKS 代理，必须使用 HTTP 代理。

## 日常使用

```bash
# 启动 Web 管理界面（浏览器自动打开 http://localhost:8888）
xray-ui

# 快捷命令
xray-restart     # 重启 xray（改配置后用）
xray-stop        # 停止 xray
xray-status      # 查看运行状态
xray-log         # 查看最近日志
xray-config      # 终端编辑配置文件
```

## Web 管理界面功能

- **节点管理**：添加/编辑/删除 VLESS/VMess 节点，支持粘贴 `vless://` / `vmess://` 链接一键导入
- **路由分流**：可视化配置哪些域名走哪个节点
- **均衡组**：创建负载均衡组，支持 leastPing/leastLoad/random 策略
- **订阅导入**：粘贴订阅地址，自动解析节点列表
- **状态监控**：实时查看 xray 运行状态
- **单节点测速**：测试各节点延迟
- **日志查看**：查看 xray 运行日志

## 跨平台支持

| | macOS | Windows | Linux |
|--|-------|---------|-------|
| 安装脚本 | `install.sh` | `install.bat` | `install-linux.sh` |
| 服务管理 | launchd | Task Scheduler | systemd (user) |
| xray 二进制 | `xray` | `xray.exe` | `xray` |
| 代理环境变量 | `.zshrc` | `setx` (用户级) | `.bashrc` |
| 系统代理 | 系统设置→网络→代理 | 设置→网络→代理 | 环境变量 |

## CLI 工具代理配置

安装脚本会自动设置 `http_proxy` / `https_proxy` 环境变量。以下工具将自动使用代理：

- **Claude Code CLI** — 自动识别 `http_proxy`
- **npm / yarn / pnpm** — 自动识别 `http_proxy`
- **curl / wget** — 自动识别 `http_proxy`
- **git** — 自动识别 `http_proxy`（clone/fetch/push）

如果新开终端没生效，手动加载：
```bash
source ~/.bashrc   # Linux
source ~/.zshrc    # macOS
```

Windows 需要重新打开命令行窗口。

## 离线部署包

```bash
# 在有网的机器上打包
./package.sh all        # 同时打包 macOS + Windows + Linux
./package.sh macos      # 仅 macOS (arm64)
./package.sh windows    # 仅 Windows (x64)
./package.sh linux      # 仅 Linux (amd64)
./package.sh linux arm64  # Linux arm64

# 产出：
# /tmp/xray-manager-build/xray-manager-macos-arm64-v2.0.tar.gz
# /tmp/xray-manager-build/xray-manager-windows-x64-v2.0.zip
# /tmp/xray-manager-build/xray-manager-linux-amd64-v2.0.tar.gz
```

新电脑解压后运行安装脚本即可，不需要网络。

## 分流规则

- `proxy-google` → YouTube、Google AI Studio、Gmail
- `proxy-claude-gpt` → Claude、ChatGPT、Telegram
- `direct` → 中国大陆域名/IP、DNS 服务器
- `block` → UDP 443（QUIC）

## 换节点 / 改配置

两种方式：
1. **Web UI**：`xray-ui` → 编辑节点 → 保存并重启
2. **终端**：`xray-config` 编辑 JSON → `xray-restart` 生效

## 注意事项

- **config.json 不提交 git**：包含节点地址和 UUID，属于敏感信息
- **xray 二进制不提交 git**：OS 特定，各机器自行安装
- **V2RayN 可以卸载**：本工具完全替代 V2RayN 的功能

## 卸载

### macOS
```bash
launchctl bootout gui/$(id -u)/com.xray.proxy
rm -rf ~/xray ~/Library/LaunchAgents/com.xray.proxy.plist
# 从 ~/.zshrc 中删除 "# === Xray Manager ===" 到 "# === End Xray Manager ===" 之间的内容
```

### Windows
```bash
schtasks /Delete /TN "XrayProxy" /F
rmdir /s /q %USERPROFILE%\xray
setx http_proxy ""
setx https_proxy ""
```

### Linux
```bash
systemctl --user disable --now xray-proxy
rm -rf ~/xray ~/.config/systemd/user/xray-proxy.service
# 从 ~/.bashrc 中删除 "# === Xray Manager ===" 到 "# === End Xray Manager ===" 之间的内容
```
