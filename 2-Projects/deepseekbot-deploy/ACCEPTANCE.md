# 验收记录 · 2026-10-19

- Mac mini：DSH 0.2.1-rc.2 + deepseekbot 1.4.0，独立 home/Profile。
- 公网地址：https://cli4.hahaxiong.cc/deepseekbot/

| 检查 | 实测结果 |
|---|---|
| HTTPS 证书 | 有效，现有证书到期 2026-12-17 |
| 未登录首页/API | 401 |
| 原 cli4 首页保护 | 原 Basic Auth 保持，401 |
| 私密启动链接登录 | 重定向到无 token 路径；页面正常 |
| Cookie | HttpOnly + Secure；限定 Path=/deepseekbot/ |
| Bot 模式 | 浏览器可见首页、托布、小深、模型配置入口 |
| 首轮浏览器错误 | pageerror 0，HTTP >=400 的资源 0 |
| WebSocket | 公网真实认证 Upgrade=101；浏览器创建 /deepseekbot/api/remote.mux |
| 服务/隧道重启 | 两服务重启成功，runs 1→2；之后 PID 保持 81420 / 81421 |
| 旧 Cookie 跨重启 | HTTP 200，浏览器恢复 Bot 模式 |
| 重启后浏览器 | HTTP 200、pageerror 0、Bot 数据保留；首访更新弹窗可关闭 |
| 手机尺寸首屏 | WebKit 390×844，文档 scrollWidth=390；未测试完整手机对话 |
| Bot 持久化 | CLI 与浏览器均仍可见“小深”与总管 |
| SSH 限权 | sshd -T 确认仅 remote forwarding，permitlisten=127.0.0.1:13980；禁密码/PTTY/Agent/X11 |
| 回环监听 | Mini 31980、HK 13980 不直接公网监听 |
| 双端检查 | Studio 与 HK 多轮未认证 401；HK 回源 401；不是两家居民宽带测试 |
| 前端主要合并包 | 2 包 HTTP 200，传输约 4.22 MB / 2.24 MB，直连约 0.80 / 0.71 秒 |
| 模型就绪 | 专用 Key 配置后目录包含 Flash/Pro；小深与托布显式配置 deepseek-official/deepseek-flash/high |
| 真实回复 | handled，回复“川哥，DeepSeek Bot 已连通。”；工具调用未测试，已产生 API 用量 |
| 整机重启/断电 | 未测试；只测进程级重启 |

浏览器复验中，Studio 继承的代理链路曾令页面加载超时；直连根路径约 0.28 秒，原代理样本约 10.35 秒。随后浏览器实际恢复 Bot 页面。自动检查也遇到隐藏同名“小深”元素和首次更新弹窗，已改为检查页面内容，不能将这些选择器失败归为服务不可用。单次活动快照请求在页面切换期间被取消；正常首页最终显示“暂无 Bot 活动”。

首屏截图：`output/playwright/initial.png`；Bot 模式：`output/playwright/bot-mode.png`。截图不含模型凭据或启动令牌。

后续已按用户指定的 Air RTF 完成专用 Key 配置和真实回复，见下方补充。

后续截图：`output/playwright/after-restart.png`、`output/playwright/mobile.png`。最终复核时间 2026-10-19 09:27 CST；两服务 runs 仍为 2，无观察到重复重启。

## 专用 Key 接入补充（09:45 后）

- mDNS 实时发现 Air，使用此前可信主机密钥严格校验，确认用户 Rayman.Chen 与指定 RTF 可读。
- RTF 转纯文本只在 SSH/进程内传递；唯一 Key 通过 SSH stdin 写入 Mini 原生 credentials `refs.DEEPSEEK_API_KEY`。原 browser-session 记录保留，权限 0600。
- 小深/托布模型计划 revision 1：deepseek-official / deepseek-flash / high。
- 验收消息 ID：human-537e2171-c597-42c3-ad5c-a8a58168665b，最终 handled；返回“川哥，DeepSeek Bot 已连通。”，回复时间 2026-10-19T01:45:38.211Z。
- Bot usage 接口首次记录：inputTokens=26849，outputTokens=425，cacheReadTokens=27008，totalTokens=54282，periodRecords=1。保留应用统计原值，不等同于已核对官方账单；未计算金额。
- 接入后又做一次 Host 进程重启：model-catalog 成功，Flash/Pro 仍可见；未重启隧道，未修改源 RTF。
- 重启后再次查询同一验收消息，状态仍为 handled，回复与 message ID 完整保留；公网未登录仍返回 401。
- 检查本项目 4 份日志、2 份部署文档、启动脚本共 7 个文件，未发现专用 Key 明文；未输出 Key 的任何部分。
- 凭据接入后的 Host PID=89326、runs=3；这次额外进程重启覆盖前述 09:27 基线。
- 公网 WebKit 复验：会话列表显示真实回复摘要“川哥，DeepSeek Bot 已连通。”，收到 13 个 WebSocket frame，pageerror=0；Home 模型引导由第 1 步推进至第 2 步。截图 `output/playwright/key-connected.png`。
- 消息接口读回同一会话 revision=2：用户请求和 Bot 完整回复均存在，deliveries=handled。

## 日常入口 401 反馈修正

用户当前浏览器未持有 DSH 签名 Cookie；先前私密首次入口只放在 Studio，未方便地送达 Air。已在 Air `~/Documents/DeepSeekBot/首次登录.webloc` 落地最新私密入口（0600），并通过系统 open 发起默认浏览器打开（退出码 0）。Air 本机独立 HTTP 验证：启动链接换 Cookie 后 HTTP 200，再携 Cookie 访问干净日常入口 HTTP 200；临时测试 Cookie 文件已删除。该验证不等同于读取用户浏览器 Cookie；实际浏览器显示由用户观察。未关闭认证、未将启动令牌公开挂在服务器。refresh-access.py 增加 --air 同步能力。

修正后用户回复“OK”，并授权总结经验、更新记忆与提交推送。本轮归档不重启线上服务或重复模型调用；保留上述历史实测与未验边界。截图路径为本机忽略产物，未随 Git 上传。

## 密码登录补充（11:18）

当前首页匿名行为已由 401 改为 200 密码表单，API 保持 401。Air 指定密码已加盐哈希配置；真实 WebKit 验证错误拒绝、正确进入 15 个 Bot、30 天原生 Cookie、浏览器关闭重开免登录及退出均通过。历史原生认证/模型验收不变。见 [密码登录记录](PASSWORD-LOGIN-20261019.md)。
