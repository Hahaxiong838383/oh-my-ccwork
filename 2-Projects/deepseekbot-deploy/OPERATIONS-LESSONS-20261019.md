# DeepSeekBot 部署与运维经验归档

2026-10-19，codex（OpenAI）。用户确认本轮结果后，要求总结经验、更新记忆与skills、commit + push。本次仅归档知识与技能，没有重启线上服务或追加业务测试。

## 已确认的经验

| 经验 | 证据与以后如何处理 |
|---|---|
| 先查现网，再补缺口 | Mini早已在chuan-mesh；用户说“拉进组网”不代表需要重新安装。先核VIP/身份/peer与服务监听，再补专用入口。 |
| 入站转发与出站代理分开 | 公网Nginx/SSH备用不妨碍模型出站直连。运行进程环境、官方DNS/socket、DSH代理模块负测共同举证；启动脚本改了不等于现有进程已重载。 |
| 首页200不是应用验收 | 密码表单、原生Cookie、认证API/WS和Bot主面板分别验。HTTP mesh缺randomUUID会在资源已加载时崩面板，不能据此判网络坏。 |
| 测实际设备、实际大资源 | Air认证18/18成功、中位18.6ms；两份8MB以上资源约0.32/0.37秒。Studio浏览器三分钟WS零断开是另一视角，不能写成Air浏览器人工验收或长期稳定保证。 |
| 凭据与记住登录各有边界 | RTF只进程内读取，服务端存加盐哈希，浏览器存签名Cookie；公网Secure与mesh HTTP Cookie分开验证，密码管理器自动保存不能代替关闭重开测试。 |
| 恢复内容与恢复业务分开 | 13迁入Bot、2群、技能与4,940工作文件不等于源聊天/长期记忆/凭据/业务环境全部恢复。缺少的源数据继续明示，不靠空文件或假数据补齐。 |
| 保留正在运行的任务 | 当前Host已直连，固化脚本无需为“证明修改”重启Host；网关可独立重载。失联旧隧道或失效connector只处理本项目精确目标。 |
| 归档也要隔离并验真 | 主仓有其他任务，独立worktree只提交本次路径。技能单一真源在 `.claude/skills/`，`.agents`入口不复制正文；共享记忆在仓外，需独立备份/写后回读。 |

## 已更新的技能

- [easytier-mesh-ops](../../.claude/skills/easytier-mesh-ops/SKILL.md)：新增[Mesh Web接入与验收](../../.claude/skills/easytier-mesh-ops/references/mesh-web-access.md)；修正“废弃UDP11010已从所有节点删除”的过时断言；将白屏排障分为吞吐、认证、应用与浏览器安全上下文；扩容前先检查是否已有节点。
- [ssh-tunnel](../../.claude/skills/ssh-tunnel/SKILL.md)：新增[Web服务分层诊断](../../.claude/skills/ssh-tunnel/references/web-service-diagnostics.md)；覆盖公网断联证据、精准处理旧隧道、服务出站直连、密码入口与原生Cookie；同时修正 `.agents/skills/ssh-tunnel/SKILL.md` 原先漏写点号的真源路径，使多引擎入口可实际读取。

本次修改针对已观察到的问题，没有将固定IP、短测成功或单一HTTP兼容方案推广为所有应用的默认规则。未新增代理、监控任务或通知，也没有修改其他服务的运行配置。

## 后续使用入口

- 推荐Mesh：`http://10.10.10.11:31982/`，Air `~/Documents/DeepSeekBot/Mesh入口.webloc`。
- 公网备用：`https://cli4.hahaxiong.cc/deepseekbot/`；原密码，两入口各自登录一次。
- [直连与Mesh证据及回滚](MESH-DIRECT-20261019.md)、[公网稳定性边界](STABILITY-20261019.md)、[密码登录](PASSWORD-LOGIN-20261019.md)、[恢复范围](GROK-RESTORE-20261019.md)。
- 未验：换网/异地中继长稳、整机断电重启、HTTP下麦克风与剪贴板等安全上下文功能。源历史资料与完整业务依赖的缺口仍在。

技能校验应包含frontmatter、相对链接可解析、多引擎入口仍指向单一真源、只提交本次文件及无凭据泄漏；没有运行新的生产故障注入或模型调用。共享 `0-System` 不随Git提交，候选/原件/逐文件写后回执在本机 `~/.local/share/deepseekbot/memory-backups/` 独立保存。

## X 通道补充

“把教程发给Bot”只证明消息交付；用户要求解决问题时，应实际修复路由、提供可运行工具并让Bot亲跑。此次已纠正“Mini无ZGO”的过时判断，用X定向规则和公开单帖工具取得真实内容，且保留搜索/时间线缺口。方法已归入 [Xray专项参考](../../.claude/skills/xray/references/x-public-post-access.md)，实证见 [X访问修复](X-ACCESS-20261019.md)。
