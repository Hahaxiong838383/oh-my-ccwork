# Xray Manager

> Xray 分流代理管理工具（macOS / Linux / Windows）。零依赖，单文件 Python Web UI + 系统服务开机自启。
>
> **V1.3**: 配置向导 + 系统代理自动设置

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

不用 V2RayN，直接用 xray-core + 系统服务（macOS launchd / Linux systemd）+ Python Web UI 管理。

## 当前部署状态（Mac mini）

已于 2026-03-22 部署完成：

```
~/xray/
├── xray              # Xray-core 二进制（从 V2RayN 复制）
├── config.json        # 分流配置（V3 版）
├── geoip.dat          # IP 地理数据
├── geosite.dat        # 域名地理数据
├── xray.log           # 运行日志
└── xray-manager.py    # Web 管理工具
```

**launchd 服务**：`com.xray.proxy`（开机自启，崩溃自动重启）

**分流规则**：
- `proxy-google` → YouTube、Google AI Studio、Gmail
- `proxy-claude-gpt` → Claude、ChatGPT、Telegram
- `direct` → 中国大陆域名/IP、DNS 服务器
- `block` → UDP 443（QUIC）

## 文件结构

```
2-Projects/xray-manager/        # 项目源码（git 管理）
├── xray-manager.py              # Web UI 管理工具（Python 单文件，零依赖）
├── install.sh                   # 一键安装脚本
├── config/
│   └── config.json              # 分流配置模板
├── service/
│   ├── com.xray.proxy.plist     # macOS launchd 服务模板
│   └── xray.service             # Linux systemd 服务模板
└── README.md                    # 本文件
```

## 安装（新电脑 / 重新部署）

```bash
cd ~/mycc/2-Projects/xray-manager
./install.sh
```

安装脚本自动完成：
1. 创建 `~/xray/` 目录
2. 下载 xray-core 二进制（自动识别 OS + 架构）
3. 下载 geoip.dat / geosite.dat
4. 复制分流配置
5. 注册系统服务（macOS: launchd / Linux: systemd user service）
6. 添加 shell 快捷命令到 `~/.zshrc`（macOS）或 `~/.bashrc`（Linux）

## 日常使用

```bash
# 启动 Web 管理界面（浏览器自动打开 http://localhost:8888）
xray-ui

# 快捷命令
xray-restart     # 重启 xray（改配置后用）
xray-status      # 查看运行状态
xray-log         # 查看最近日志
xray-config      # 终端编辑配置文件
```

## Web 管理界面功能

- **节点管理**：添加/编辑/删除 VLESS 节点，支持粘贴 `vless://` 链接一键导入
- **路由分流**：可视化配置哪些域名走哪个节点
- **状态监控**：实时查看 xray 运行状态
- **单节点测速**：测试各节点延迟
- **日志查看**：查看 xray 运行日志

## 换节点 / 改配置

两种方式：
1. **Web UI**：`xray-ui` → 编辑节点 → 保存并重启
2. **终端**：`xray-config` 编辑 JSON → `xray-restart` 生效

## 端口

| 服务 | 端口 | 说明 |
|------|------|------|
| SOCKS 代理 | 10808 | 系统代理入口 |
| Web 管理 UI | 8888 | 仅本地访问 |

## 注意事项

- **系统代理**：V1.3 起配置向导自动设置系统代理（SOCKS + HTTP/HTTPS），也可在管理界面手动开关
- **V2RayN 可以卸载**：本工具完全替代 V2RayN 在 macOS 上的功能
- **config.json 不提交 git**：包含节点地址和 UUID，属于敏感信息。模板在 `config/config.json`
- **xray 二进制不提交 git**：OS 特定，各机器自行安装

## 版本记录

| 版本 | 日期 | 变更 |
|------|------|------|
| V1.3 | 2026-03-23 | 配置向导、系统代理自动设置、自动更新（订阅每天/内核+GeoIP 每周）、Web UI 更新管理 Tab |
| V1.2 | 2026-03-22 | 跨平台支持（macOS + Linux + Windows）、离线部署包、VMess 协议、订阅导入、均衡组 |
| V1.0 | 2026-03-22 | 初始版本：VLESS 节点管理、路由分流、Web UI |

## 卸载

**macOS:**
```bash
launchctl bootout gui/$(id -u)/com.xray.proxy
rm -rf ~/xray
rm ~/Library/LaunchAgents/com.xray.proxy.plist
# 从 ~/.zshrc 中删除 "# === Xray Manager ===" 到 "# === End Xray Manager ===" 之间的内容
```

**Linux:**
```bash
systemctl --user stop xray.service
systemctl --user disable xray.service
rm -rf ~/xray
rm ~/.config/systemd/user/xray.service
systemctl --user daemon-reload
# 从 ~/.bashrc 中删除 "# === Xray Manager ===" 到 "# === End Xray Manager ===" 之间的内容
```
