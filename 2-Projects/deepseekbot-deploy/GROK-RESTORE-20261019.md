# Grok Bot → DeepSeekBot 恢复记录 · 2026-10-19

状态：仓库中可恢复的 Bot、群组、技能与工作文件已迁入 Mini；原平台完整运行环境未恢复。缺原始私有记忆/聊天/最新 routine 导出、凭据登录态和部分依赖，不能称 100% 完整恢复。

## 来源与文件完整性

源：[Hahaxiong838383/grokbot-backup](https://github.com/Hahaxiong838383/grokbot-backup)，提交 `d5fe696677db2a6dd62270b3022e339476099a37`，时间 2026-10-17 15:16:14 +0800。已补取 Git 历史，未找到 `workspace/backup/export/` 的提交。

| 对象 | 恢复与核验结果 |
|---|---|
| Bot | 13 个，原 profile 字节一致，完整 description 保存在 SOUL.md；原小深与 Tob 保留，总计 15 个 |
| 群组 | 爱视可舆情抓取 6 人、爱视可运营群 3 人，成员映射核同 |
| 技能 | 8 套，每个迁入 Bot 安装一份原生 `.agents/skills` 适配副本，104 份由当前 DSH provider 解析并加载全文，0 warning；原件另保留 |
| 源文件 | 669 文件，697,372,114 字节，源/目标 SHA-256 全同 |
| Git LFS | 50 对象，664,291,139 字节，全部按 pointer OID 核 SHA-256；不把 pointer 当附件 |
| 解包原件 | 4,940 文件，971,935,111 字节；无越界路径或非普通文件 |
| 路径适配 | 501 个文本文件仅在副本替换旧绝对路径；原字节保留；不代表 Linux 程序已移植成功 |
| 传输验收 | 原件、适配副本及回执 9,883 文件，1,945,024,447 字节；再加源仓 669 文件，逐文件 size/SHA-256 无差异 |
| 模型 | 13 Bot 均 deepseek-official/deepseek-flash/high，orchestrator 与 assignment 路由一致 |
| 工作区 | 各 Bot 授予恢复 runtime 工作区；orchestratorWrite=false，保原生审批边界 |
| 定时配置 | 可确认提示和时刻的 AI 资讯 08:59、16:59，舆情日报 09:37 共 3 条，以 Asia/Shanghai 禁用保存；其余片段存档，旧 17:07 晚报未启用 |

本轮使用 Git 现有凭据访问私有仓；LFS 下载凭据仅进程内使用。首次 Python HTTPS 缺本机 CA，切换 `/etc/ssl/cert.pem` 后成功，未禁用 TLS 验证。LFS 支持 partial 续传，4 并发；文件从 Studio 经既有 Mini 雷电链路以 rsync partial 同步，没有通过 Air 跨站搬运。

## Mini 上的恢复位置

基目录：`/Users/rayman.chen/local/deepseekbot/workspace/grokbot/`。

- `source-repository/`：源仓当前文件，LFS 已物化。
- `original/`：安全解包后的原件，当前 Git 配置文件优先于历史归档同路径。
- `runtime/`：路径适配副本和共享工作区；`MIGRATION.md` 是当前恢复边界，`migration-map.json` 是原 ID→新 ID 映射。
- `transfer-manifest.json`、`source-manifest.json`、`transfer-verification.json`、`native-verification.json`：逐文件与原生配置验收。
- 原生 Bot Memory：`data/botharness/bots/<新ID>/memory/`，含 SOUL.md、MEMORY.md、source/profile.json、source/settings.json、原 workflows 与适配 `.agents/skills`。

`MEMORY.md` 是本次根据备份生成的恢复索引，不是原长期记忆。技能将原中文 frontmatter name 规范成目录英文名以通过 DSH 校验，保留原说明与职责；新增迁移提示，防止误把旧登录状态、旧批准和设备地址当成当前真值。原 UI 短描述受 160 字限制，完整职责不截断。

## 实际验收

- 13 份原始 profile 与源仓逐字节核同；原完整职责均在 SOUL.md；13 模型计划与工作区授权核对通过。
- 两个群原生成员关系为 6/3 人；群唤醒设为 mentions，避免迁移后无任务背景活动。
- 幕僚长真实验收消息 `human-952c053d-5b79-45a3-a7b1-09ed73672c37` handled，回复“我是幕僚长，已在 Mac mini 的 DeepSeekBot 恢复。”；该验收没有工具调用、派工或外发。
- Host 进程重启后仍有 15 个 Bot，原小深/Tob 保留；同一验收消息仍 handled，回复保留。
- Air 与 Studio 私有首次入口已刷新。日常入口仍为 https://cli4.hahaxiong.cc/deepseekbot/ 。
- 隧道修复后的公网 WebKit 验收：13 个迁入 Bot 名称与 2 群均出现在页面，Bot 名称缺失 0、pageerror 0，收到 9 个 WebSocket frame，跳转后的地址不含 token。只验证列表与已存回复，不冒充各业务工作流已跑通。
- 前轮浏览器第一次选到隐藏同名元素，后两次遇公网回源超时；修正可见定位并修复隧道后通过，保留失败事实。

## 未恢复与原因

1. 源仓明确排除 `store.db`、平台插件和密钥/登录态；`export/` 实际不存在。原聊天、原长期记忆、完整最新 routine 无法从仓库生成。档案里找到的 routine/记忆片段按历史资料保存。
2. Grok serverId、Temporal harness、avatarShape、notifyOnAgentUpdates 等字段在原 profile/settings 留存，但没有完全等价的 DSH 行为；已映射名称、职责、可支持的颜色与群成员。
3. Linux sysops、cgroup、apt、原组网/代理/桥接不能直接在 macOS 执行，未启动或改 Mini 网络。原微信档案只恢复文件，没有覆盖用户当前微信资料或声称已登录。
4. 当前非交互 SSH PATH 下未检出 lark-cli/adb；Vault 主机严格 SSH 认证拒绝，未获取业务 Key/webhook/login。业务采集、飞书写表/发报和微信收发未做端到端验收。
5. 没有恢复旧 17:07 晚报为启用任务，也没有把旧对外动作许可视为本轮新的发信指令。

后续入口：补齐原 Grok 平台导出的记忆/routine/聊天和必要凭据，逐项适配 macOS 依赖，再对各业务链路验收后启用计划。本次已询问用户原云电脑是否仍可访问，尚未获得入口。

## 备份、回滚与私有证据

迁移前停服一致性备份：`mini-tb:~/local/deepseekbot/private-backups/before-grok-import-20261019-100424/`，data 5,656 文件/150,157,239 字节，workspace 原为空，含凭据和原生数据库；备份后服务立即恢复。

迁移脚本、逐步回执、技能/重启验收在 `mini-tb:~/local/deepseekbot/private-backups/grok-import-bundles-20261019/`。Studio 私有工作目录 `~/.local/share/deepseekbot/migrations/` 保存源仓、下载校验、提取与构建脚本。内容与附件不复制进 mycc Git。

需要整体回滚时先另备当前实例和新对话，再停本任务 Host，保留当前 data 到新目录，使用上述冷备恢复 data/启动配置后加载；公网隧道不用变。工作资料与原备份保留，不执行广泛删除。不自动回滚覆盖迁移后的新工作。

署名：codex（OpenAI）| 2026-10-19

## 复验发现的公网隧道修复

约 10:15 后公网请求超时。分层检查：Mini Host 401/约 4 ms 正常；香港 HTTP80 可达，Studio 绕开现有 SSH ProxyCommand 可登录香港；香港 13980 被旧项目 sshd PID4182624 占用，回源超时；Mini 直接 SSH 重试失败，runs 已到23。没有证据把网络抖动归因于 Bot 数据导入。

只改本项目：香港 `70-deepseekbot-tunnel.conf` 增加 ClientAliveInterval 30 / CountMax 3，sshd -t 后 reload；核对进程名与监听归属后仅终止已确认的旧项目会话。Mini→Studio 雷电 SSH 已有公钥与可信指纹，实际中转到香港认证成功，未复制私钥或新增授权。`start-tunnel.py` 保留直连/auto选项，现场强制 studio 路由以避开当前不稳直连；原生服务与资料仍在 Mini。

修后香港 13980 回源401/约0.105s，Studio公网401/约0.270s，回环监听归属新项目会话。保留30/3双端心跳及15秒launchd重试，不宣称长期网络稳定。

备份：香港 `/etc/ssh/sshd_config.d/70-deepseekbot-tunnel.conf.before-heartbeat-20261019-101928`；Mini `private-backups/tunnel-before-fallback-20261019-101938.plist`。源配置与 wrapper 已归档在 ops/。恢复旧直连前需验证端到端SSH转发，不能仅凭端口或banner探测。未重启共享Nginx或香港服务器。

补充独立使用设备验收：Air 从本机私有 webloc 读取启动链接，经临时 Cookie 完成首次授权 HTTP 200，随后访问干净日常网址 HTTP 200；测试 Cookie 已清理，不读取用户浏览器现有 Cookie。

浏览器验收边界补充：追加尝试打开幕僚长完整会话视图时，单击/双击定位未完成，等待完整回复超时；不宣称该 UI 操作通过，也不据此判定产品故障。列表/登录验收已通过，完整回复和跨重启持久化由原生消息接口独立验证。
