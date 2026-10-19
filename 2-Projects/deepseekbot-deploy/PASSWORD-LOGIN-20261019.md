# 密码登录与记住登录 · 2026-10-19

已部署。日常入口 https://cli4.hahaxiong.cc/deepseekbot/ 未认证时显示登录页；默认勾选“记住登录（30 天）”。Air 两个 webloc 均改为干净网址，使用说明已更新。已有有效原生登录保留。

## 实现与边界

- 用户指定 Air `Documents/陈川个人站/DeepSeek Bot 密码.rtf`。RTF 转文本只在 SSH/进程内处理，不复制原文、不输出密码、不进入 argv 或 Git。
- 服务端只保存加盐 scrypt 哈希：N=32768、r=8、p=1、64 字节结果，随机 16 字节盐；Mini `~/local/deepseekbot/auth/credential.json` 权限 0600、目录 0700。
- 新增 Node 内置模块网关 `127.0.0.1:31981`，通过 `com.mycc.deepseekbot-auth` 用户 LaunchAgent 保活。隧道只把本项目目的端口 31980 改为 31981；DSH、Bot 数据、原认证签名和 Nginx 均未修改。
- 密码通过后，由网关在服务端读取当前启动令牌，向 DSH 交换原生签名 Cookie。浏览器收到 303 干净跳转，永远不在密码登录 URL 中接触令牌。
- 原生 Cookie：30 天、HttpOnly、SameSite=Strict；网关补 Secure，既有 Nginx 限定 Path=/deepseekbot/。取消记住登录时移除 Max-Age/Expires，签名最长仍 30 天；浏览器“恢复会话”设置可能保留会话 Cookie。
- 表单提供 autocomplete=username/current-password，支持用户在浏览器密码管理器中保存。网页不在 localStorage 保存密码，未自动替用户点击浏览器的保存密码提示。
- API/WS 继续由 DSH 原生鉴权。密码 POST 要求精确同源 Origin、固定 Host、4 KiB 请求体限制、timingSafeEqual；个人入口全局最多 5 次失败/15 分钟，同一时刻只允许一次密码派生，故意不信任转发 IP 头。达到限制时，所有访客的密码登录暂时返回 429，已有会话仍可用。
- POST `_auth/logout` 同源请求可清除当前浏览器 Cookie。更换密码并不撤销已经签发的 DSH Cookie；原生私密启动链接仍可作为运维备用凭据。

## 验收

2026-10-19 11:17–11:18 CST：

| 项目 | 结果 |
|---|---|
| 自动化认证、限流、CSRF、请求体、WS 测试 | 9/9 通过 |
| Mini 真实密码 | 303、原生 Cookie、Max-Age=2592000 |
| 公网匿名首页 | 200 登录页 |
| 公网匿名 /api/remote.mux | 401 |
| 公网错误密码 | 401，无认证 Cookie |
| 公网正确密码 | 干净跳转，显示 15 个 Bot，浏览器 WS 已建立 |
| Cookie 属性 | Secure/HttpOnly/SameSite Strict/Path 子目录/30 天 |
| 真实 WebKit 持久配置关闭重开 | 无需重新登录，Bot 工作台正常 |
| 退出 | 同源 POST 清 Cookie 后显示密码页 |
| Mini 暴露面 | 31981 只监听 127.0.0.1；凭据 0600 |

浏览器脚本 `ops/verify-password.cjs` 使用临时私有 profile，结束时删除；不会输出密码、token、Cookie 值或原始异常。截图与脱敏报告在忽略目录 `output/auth/`。这不是 30 天实际等待测试；30 天由 Cookie 属性与重开实测共同确认。没有重复调用模型或发送业务消息。

首次公网提交失败已定位为既有 no-referrer 策略令 WebKit 表单发送 `Origin: null`，触发 403。仅登录页改用 same-origin 的 Header + meta，保留 null/跨站 Origin 拒绝，真实浏览器复验通过。原生启动令牌页面仍由原认证处理，未放宽整个站点策略。

## 密码更换与运维

用户修改 Air 指定 RTF 后，人工执行：

```sh
python3 ops/configure-password.py
ssh mini-tb 'launchctl kickstart -k gui/501/com.mycc.deepseekbot-auth'
```

脚本严格校验已信任的 Air 主机，哈希通过 SSH stdin 写入 Mini，旧哈希保存在该私有目录备份。不会将密码原文写入本地文件。不要把凭据目录、host.log、浏览器 profile 加入 Git。

仅回滚密码网关（保留 Bot 数据与原生认证）：将 Mini `start-tunnel.py` 的 `-R` 目的端口改回 31980，并重启 `com.mycc.deepseekbot-tunnel`。初次切换前备份为 `start-tunnel.py.pre-password-20261019`，回滚前先核对后续修改，不盲目覆盖。确认原生入口可用后停止 `com.mycc.deepseekbot-auth`；需要私密首次链接的浏览器再用 `ops/refresh-access.py --air` 更新。公网链路仍依赖 Studio 中转在线。

署名：codex（OpenAI）| 2026-10-19 11:18 CST
