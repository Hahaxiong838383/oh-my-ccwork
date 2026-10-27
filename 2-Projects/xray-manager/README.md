# Xray Manager

> Xray 分流代理管理工具（macOS / Linux / Windows）。零依赖，单文件 Python Web UI + 系统服务开机自启。
>
> **历史 V1.5（2026年3月）**: 路由拆分（搜索/GitHub→亚洲 | AI→美国）+ 系统代理 API + balancer 均衡组

## Air 受管安装维护入口（2026-10-27）

Air 使用 `cf-lisa` 自动切换控制器，维护真源见 [`maintenance-20261027/README.md`](maintenance-20261027/README.md)。该维护版由 `xray-manager.py` 和 `managed_status.py` 两文件配合工作；上级同名 manager 是独立跨平台主源码，不能直接覆盖 Air。本文下方的3月部署、通用安装、切换和编辑命令均不是现有 Air 的操作指南。

维护版8888页面通过只读 `/api/managed-status` 查询实际 RoutingService override、控制器进程和45秒状态新鲜度，区分探测正常、部分可达、阻断、过期、控制异常及无法确认；规则资产pending单独显示为“待确认应用”。静态 `cf-block` 不等于当前出站，TCP测试也不代表目标业务成功。节点、导入、端口、均衡组和路由编辑入口在受管或状态未知时锁定，后端409保护仍须保留。

通用 `install.sh` 检测到controller配置或LaunchAgent即在下载、写文件或改服务前退出。部署是否完成、两文件SHA与线上验收以当次回执为准，不能仅凭仓库存在维护包认定已上线。

## 历史项目背景（2026年3月）

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

## 历史部署快照（MacBook Air，2026-03-23）

以下为当时部署记录，不代表当前节点、路由或运行态：

```
~/xray/
├── xray              # Xray-core 二进制
├── config.json        # 分流配置（含 balancer 均衡组）
├── geoip.dat          # IP 地理数据
├── geosite.dat        # 域名地理数据
├── xray.log           # 运行日志
├── xray-manager.py    # Web 管理工具
└── switch-to-xray.sh  # v2rayN → xray 一键切换脚本
```

**launchd 服务**：`com.xray.proxy`（开机自启，崩溃自动重启）

**分流规则（balancer 均衡组）**：

| 分组 | 策略 | 节点池 | 说明 |
|------|------|--------|------|
| Claude/GPT/Grok | 固定出站 | 美宅专用 US | AI 服务需要稳定美国 IP |
| Gemini/AI Studio/NotebookLM | leastPing | US-V1, US-R1, US-R2 | Google AI 走美国节点 |
| Google 搜索/Gmail/通用 | leastPing | HK×4, TW×2, JP×4, SG×2 | 搜索走亚洲低延迟 |
| GitHub 全系 | leastPing | HK×4, TW×2, JP×4, SG×2 | 代码拉取走亚洲低延迟 |
| YouTube/视频娱乐 | leastLoad（网速优先） | HK, TW, SG, JP 多节点 | 视频走带宽优先 |
| 大陆域名 | direct | 直连 | — |
| 其他流量 | 默认 | HK-HKT-A | — |

**V1.5 路由拆分说明**：

Google 搜索和 GitHub 从美国节点拆分到亚洲节点（`asia-fast-balancer`），原因：
- 搜索是高频短连接，延迟敏感，亚洲节点 RTT 低 100-200ms
- GitHub clone/fetch 是大文件传输，亚洲节点吞吐更稳定
- AI 服务（Claude/GPT/Gemini）保持美国节点，因为部分服务限制非美国 IP

## 文件结构

```
2-Projects/xray-manager/        # 项目源码（git 管理）
├── xray-manager.py              # Web UI 管理工具（Python 单文件，零依赖）
├── install.sh                   # macOS 一键安装脚本
├── install-linux.sh             # Linux 一键安装脚本
├── install.bat                  # Windows 一键安装脚本
├── package.sh                   # 离线安装包打包脚本
├── service/
│   ├── com.xray.proxy.plist     # macOS launchd 服务模板
│   └── xray.service             # Linux systemd 服务模板
└── README.md                    # 本文件
```

## 通用安装（未受管新电脑）

现有Air受管安装走上方维护入口，不执行以下重装流程。

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

## 通用迁移：从 v2rayN 到 xray-manager

仅适用于明确授权迁移且未受管的安装；现有Air不要调用历史批量清理脚本。

如果之前使用 v2rayN，迁移步骤：

### 方法一：一键切换（推荐）

1. 关闭 v2rayN 应用
2. 新开终端，执行：
   ```bash
   xray-switch
   ```
3. 脚本自动完成：清理旧进程 → launchctl 启动 xray → 启动 Web UI → 设置系统代理 → 验证连通性
4. 打开浏览器验证 Gemini / YouTube 可访问

### 方法二：开机自动（已配置 launchd 的情况）

重启电脑即可，xray 会通过 launchd 自动启动。如果系统代理未设置，打开 Web UI (`http://127.0.0.1:8888`) 点击「开启系统代理」按钮。

### 迁移注意事项

- **v2rayN 关闭时会清除系统代理**，所以首次切换后需要重新设置
- **终端代理环境变量**已自动写入 `~/.zshrc`，新终端自动加载
- **Chrome 如有代理扩展**需移除，否则会覆盖系统代理
- v2rayN 可以卸载，本工具完全替代其在 macOS 上的功能

## 通用版本日常使用

以下快捷命令和编辑功能适用于未受管版本；Air受管页面以维护说明为准。

### 终端快捷命令

```bash
xray-switch      # 从 v2rayN 一键切换到 xray（最常用）
xray-ui          # 启动 Web 管理界面（浏览器自动打开 http://localhost:8888）
xray-restart     # 重启 xray（改配置后用）
xray-status      # 查看运行状态
xray-log         # 查看最近日志
xray-config      # 终端编辑配置文件
```

### Claude Code skill 命令

```
/xray switch     # 从 v2rayN 一键切换到 xray
/xray status     # 检查代理状态（进程 + 系统代理 + 连通性）
/xray restart    # 通过 launchctl 重启 xray
/xray proxy on   # 开启系统代理（SOCKS + HTTP + HTTPS → 10808）
/xray proxy off  # 关闭系统代理
/xray log        # 查看最近日志
```

### Web UI 管理界面

访问 `http://127.0.0.1:8888`，功能包括：

- **节点管理**：添加/编辑/删除 VLESS 节点，支持粘贴 `vless://` 链接一键导入
- **路由分流**：可视化配置哪些域名走哪个节点
- **系统代理控制**：一键开启/关闭系统代理（页面居中按钮）
- **状态监控**：实时查看 xray 运行状态
- **单节点测速**：测试各节点延迟
- **日志查看**：查看 xray 运行日志

## 通用版本换节点 / 改配置

受管Air必须协调配置与controller guard发布，不能直接按以下两种方式独立保存。

两种方式：
1. **Web UI**：`xray-ui` → 编辑节点 → 保存并重启
2. **终端**：`xray-config` 编辑 JSON → `xray-restart` 生效

## 端口

| 服务 | 端口 | 说明 |
|------|------|------|
| SOCKS/HTTP/HTTPS 代理 | 10808 | 系统代理入口 |
| Web 管理 UI | 8888 | 仅本地访问 |

## 排查指南

当「网络不通」时按顺序检查：

| 步骤 | 检查内容 | 命令 |
|------|---------|------|
| 1 | xray 进程在跑吗？ | `ps aux \| grep xray` |
| 2 | 系统代理开了吗？（三个都要） | `networksetup -getsocksfirewallproxy Wi-Fi` |
| 3 | 端口对吗？（必须 10808） | `lsof -i :10808` |
| 4 | Chrome 有代理扩展吗？ | 用 Safari 对比验证 |
| 5 | v2rayN 残留进程？ | 多个 xray 会抢端口 |
| 6 | 终端环境变量？ | `echo $ALL_PROXY` |

## 经验教训

1. **Claude 必须走美宅节点**，其他 US 节点会 403
2. **系统代理必须同时设三个**（SOCKS + HTTP + HTTPS），否则部分应用不走代理
3. **终端代理需要 6 个环境变量**：`http_proxy` + `https_proxy` + `all_proxy`（大小写各一份）
4. **xray 进程管理必须用 launchctl**，不能 kill/killall（KeepAlive 会导致多进程抢端口）
5. **balancer 必须用 burstObservatory**，不能用 observatory（后者会导致路由规则被跳过）
6. **curl 测 claude.ai 返回 403 是正常的**（Cloudflare challenge），用浏览器验证

## 注意事项

- **config.json 不提交 git**：包含节点地址和 UUID，属于敏感信息
- **xray 二进制不提交 git**：OS 特定，各机器自行安装

## 版本记录

| 版本 | 日期 | 变更 |
|------|------|------|
| V1.5 | 2026-03-24 | 路由拆分：Google 搜索/GitHub 走亚洲节点（asia-fast-balancer），AI 服务保持美国；系统代理控制 API（get/set/toggle）+ Web UI 实时状态 |
| V1.4 | 2026-03-23 | balancer 均衡组（Gemini=leastPing, 视频=leastLoad）、burstObservatory、系统代理 Web UI 按钮、v2rayN 一键切换脚本、终端代理环境变量自动配置 |
| V1.3 | 2026-03-23 | 配置向导、系统代理自动设置、自动更新（订阅每天/内核+GeoIP 每周）、Web UI 更新管理 Tab |
| V1.2 | 2026-03-22 | 跨平台支持（macOS + Linux + Windows）、离线部署包、VMess 协议、订阅导入、均衡组 |
| V1.0 | 2026-03-22 | 初始版本：VLESS 节点管理、路由分流、Web UI |

## 通用版本卸载

以下不是受管Air的卸载清单；现有安装含独立代理、controller和维护状态，须按实际服务范围处理。

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
