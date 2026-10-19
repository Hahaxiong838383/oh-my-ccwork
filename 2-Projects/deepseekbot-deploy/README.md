# Mac mini DeepSeekBot 部署

2026-10-19，codex（OpenAI）。

状态：Mac mini 服务、持久数据、HTTPS 公网入口和专用 DeepSeek API Key 已配置；“小深”真实模型回复已验收，重启后凭据与模型目录恢复。

归档入口：[验收记录](ACCEPTANCE.md) · [决策与经验复盘](04-决策记录.md)。本目录归档部署脚本、LaunchAgent 和脱敏记录；运行数据、依赖、私钥、首次登录文件与截图不随代码提交，不能仅凭此目录完整还原实例。

## Grok 备份恢复

2026-10-19 已迁入 13 个 Bot、2 个群组、8 套技能及 4,940 个解包工作文件；原小深/Tob 保留。模型与资料已可用，缺失的原记忆/聊天/凭据和业务依赖仍待补齐，3 条恢复定时配置保持禁用。详见 [迁移记录与边界](GROK-RESTORE-20261019.md)。

## 访问

- 日常入口：https://cli4.hahaxiong.cc/deepseekbot/
- **Air 首次登录：双击 `~/Documents/DeepSeekBot/首次登录.webloc`，使用该默认浏览器完成授权后再收藏日常入口。**
- Studio 备用首次登录：打开 Studio 本机 `~/.local/share/deepseekbot/access.html`，或 `~/.local/share/deepseekbot/首次登录.md` 中的链接。文件含私密启动链接，只供本人使用，不进 Git。
- 新浏览器没有登录状态时，直接访问日常入口会返回 401，这是认证保护。
- 服务重启后原浏览器的有效 Cookie 仍可用；首次登录文件中的旧启动令牌会失效。重新生成：

```bash
python3 /Users/fu-121/mycc/2-Projects/deepseekbot-deploy/ops/refresh-access.py --air
```

日常入口现默认进入「Bot 模式」的幕僚长私聊。左侧消息列表可滚动查看 15 个 Bot 和 2 个群，群右侧同时显示成员与会话。已部署保留 1.4.0 原生经典组件的可回滚界面补丁，见 [界面恢复记录](UI-RESTORE-20261019.md)。小深与总管「托布」均配置为 `deepseek-official / deepseek-flash / high`。专用 API Key 已从用户指定的 Air RTF 读取，并通过 SSH stdin 写入 DSH 私有凭据文件；密钥不进入 argv、项目文档或工具输出。

## 部署真值

| 项目 | 值 |
|---|---|
| 项目 | BotHarness/DeepSeekBot（不是 Fei2411/ds-bot） |
| DeepSeekBot | 1.4.0 |
| DeepSeek Harness | 0.2.1-rc.2 |
| Node | 22.22.3，复用 Mini 已安装基础运行时 |
| pnpm | 项目本地 12.4.2 |
| Mac mini | `ssh mini-tb`，雷电桥 |
| 安装目录 | `/Users/rayman.chen/local/deepseekbot` |
| 独立 DSH_HOME | 安装目录下 `data/` |
| 工作目录 | 安装目录下 `workspace/` |
| 本机监听 | `127.0.0.1:31980` |
| 香港回环入口 | `127.0.0.1:13980` |
| Host LaunchAgent | `com.mycc.deepseekbot` |
| 隧道 LaunchAgent | `com.mycc.deepseekbot-tunnel` |
| 公网代理 | aliyun-hk Nginx，既有 cli4.hahaxiong.cc 站点新增独立路径 |
| 默认权限 | `workspace-write`，保留审批；不是完全独立的虚拟机 |

链路：浏览器 HTTPS → 香港 Nginx → 受限 SSH 反向隧道（当前经 Studio 雷电中转）→ Mac mini DSH。

2026-10-19 迁移复验遇到 Mini 直连香港超时与服务端旧隧道占端口，已仅对本项目添加服务器 ClientAliveInterval=30 / ClientAliveCountMax=3，并采用 `start-tunnel.py`。当前 LaunchAgent 指定 `DEEPSEEKBOT_TUNNEL_ROUTE=studio`，使用 Mini→Studio 雷电 SSH→香港，依赖 Studio 在线；`auto`/`direct` 模式保留待直连链路稳定后评估，不能把 TCP/SSH banner 探测成功等同完整转发可用。未改公网域名、Nginx或 Mini 全局网络，长期稳定性仍待观察。

依赖在本项目内安装并固定版本；未更改现有其他应用的依赖。两个 LaunchAgent 在该用户登录时自动运行、异常退出自动恢复。当前 Mini 系统 sleep=0；未做整机断电/重启验证，登录前自动运行不在本次承诺范围。

认证使用 DSH 启动令牌换取签名 Cookie，Nginx 将 Cookie 限定到 `/deepseekbot/` 并添加 Secure。API/WebSocket 均需认证。该路径没有套用原站 Basic Auth，原站 `/` 仍保留其 Basic Auth。启动令牌不写入普通访问日志；Host 日志和凭据文件仅限本机用户读取。

关闭额外 Session Log 上传、会话遥测、插件清单上传、桌面产品遥测及 Bot 遥测。正常模型请求仍会发送对话上下文至选定服务商。

## 运维

```bash
# 查看 Bot（自动在进程内读取当前 Host 令牌，不打印凭据）
ssh mini-tb '~/local/deepseekbot/dsb list'

# 状态
ssh mini-tb 'launchctl print gui/501/com.mycc.deepseekbot'
ssh mini-tb 'launchctl print gui/501/com.mycc.deepseekbot-tunnel'

# 仅重启本项目
ssh mini-tb 'launchctl kickstart -k gui/501/com.mycc.deepseekbot'
ssh mini-tb 'launchctl kickstart -k gui/501/com.mycc.deepseekbot-tunnel'
```

Host stderr：`~/local/deepseekbot/logs/host.err.log`；隧道 stderr：同目录 `tunnel.err.log`。`host.log` 含私密启动链接，禁止直接贴到工单或聊天。

公网隧道专用账号 `deepseekbot-tunnel` 只允许远程转发 `127.0.0.1:13980`，禁密码、交互终端、Agent/X11 转发。私钥只在 Mini 的项目 `tunnel/` 下。

## 回滚

先停两个专用 LaunchAgent，保留安装和数据目录：

```bash
ssh mini-tb 'launchctl bootout gui/501/com.mycc.deepseekbot-tunnel'
ssh mini-tb 'launchctl bootout gui/501/com.mycc.deepseekbot'
```

Nginx 修改前备份：`aliyun-hk:/etc/nginx/sites-available/cc-remote-v4.before-deepseekbot-20261019-091839`。回滚时优先仅移除本次新增的两个 `/deepseekbot` location，避免覆盖后来改动，再运行 `nginx -t && systemctl reload nginx`。保留 Bot 数据；不得用宽泛 pkill。

SSH 专用配置：`/etc/ssh/sshd_config.d/70-deepseekbot-tunnel.conf`。确认隧道已停后可移除此任务配置及专用账号的授权公钥，再 `sshd -t` 后 reload；原 SSH 运维入口不改。

## 模型验收与边界

2026-10-19 09:45 首次真实回复：“川哥，DeepSeek Bot 已连通。”，消息 ID `human-537e2171-c597-42c3-ad5c-a8a58168665b`，状态 handled。服务重启后模型目录仍包含 Flash 与 Pro。凭据文件 `data/.credentials.yaml` 权限 0600，保留原浏览器签名记录；取用期间未在 Studio 留存原始 RTF 或明文 Key 副本。

实际默认模型为 `deepseek-flash`（目录显示 DeepSeek-V4.1-Flash），推理档 high。真实验收已有 API 用量，不再是零调用状态；用量详见 ACCEPTANCE.md，未换算账单费用。工具执行、多 Bot 派工和 IM 接入不在本次最小对话验收范围。

提议的 `deepseekbot.hahaxiong.cc` 尚未配置；当前交付固定 HTTPS 子路径。现有 Cloudflare 凭据无此 Zone 管理权限，不以临时隧道替代。

上游依据：[安装指南](https://deepseekbot.app/docs/installation/)、[DSH 公网反向代理指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/public-deployments.md)。
