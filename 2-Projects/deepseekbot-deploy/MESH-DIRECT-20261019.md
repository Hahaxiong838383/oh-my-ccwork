# DeepSeekBot 直连与 EasyTier 入口

2026-10-19，codex（OpenAI）。结论：当前模型出站已证实直连；Mini 原本就在 chuan-mesh，本次补齐专用 Web 入口。Air 当前 P2P 访问成功，短时观测通过，不能替代异地或长期稳定性验收。

## 使用

- 推荐：**http://10.10.10.11:31982/**，仅已连接 chuan-mesh 的设备可达。
- Air：`~/Documents/DeepSeekBot/Mesh入口.webloc` 已创建，使用说明已更新；原说明备份为同目录 `使用说明-mesh启用前.txt`。
- 输入原密码，默认记住登录30天。Mesh与公网各自保存 Cookie，首次各登录一次。
- 公网备用：https://cli4.hahaxiong.cc/deepseekbot/ ，保留现有香港与 Studio 中转。

Mesh HTTP 仅绑定 EasyTier 地址，链路由 EasyTier 默认加密承载，不是公开 HTTP 服务。浏览器仍会按非 HTTPS 处理：密码管理器自动保存因浏览器而异；麦克风、剪贴板等需要安全上下文的功能未验收。30天登录 Cookie、浏览器重开恢复、原生 Bot 页面与 WebSocket 已实测。

## 出站直连证据与固化

- Mini 系统 HTTP/HTTPS/SOCKS 代理均关闭。Host、两个认证网关、隧道进程未发现 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 等代理变量。
- Host PID11167 的模型连接直达 `123.125.246.121:443`，与当时 `api.deepseek.com` DNS 结果一致；路由经 en0 默认网关，不经过本地代理端口。API IP 属动态证据，不应固定写入 hosts。
- DSH_HOME 与 workspace 均无 `.env` 代理回填。
- `ops/direct-env.sh` 清除常见代理环境变量，设置 `NO_PROXY=*`、`no_proxy=*`、`NODE_USE_ENV_PROXY=0`；Host 与两个认证网关启动器统一引用。
- 负测：故意继承 `127.0.0.1:9` 无效代理后引用脚本，再用实际安装的 DSH launch-environment/http-proxy 模块模拟 `.env` fallback，官方API、Bot站点与mesh地址均 `proxied:false`。无 Key 的官方 models 请求返回401，证明直连TLS/HTTP可达，不产生模型调用。
- 两个网关当前已运行新环境。Host 当前已实测直连，但新启动脚本环境会在下次正常启动时加载；为保留正在运行的用户任务，本轮没有重启 Host。它保持 PID11167/runs3，隧道保持 PID21226/runs59。
- 这里的“直连”指服务/模型出站；公网备用入口仍有 Nginx 和 SSH 入站转发。自定义工具自行指定代理不在本次统一环境核验范围。

## EasyTier 与专用网关

Mini 原有 EasyTier 2.6.4、VIP `10.10.10.11`、system LaunchDaemon `cn.easytier.mesh` 正常；Air 为 `10.10.10.31`。未重复安装、分配IP、改网络名/密钥，也未重启组网进程。

新增 `com.mycc.deepseekbot-mesh` LaunchAgent，通过 `start-auth.sh --mesh` 启动认证网关：

```text
Air 浏览器 → EasyTier P2P/必要时中继 → Mini 10.10.10.11:31982 → DSH 127.0.0.1:31980
```

网关只绑定固定mesh地址，未监听0.0.0.0或LAN地址。外部Host/Origin匹配后，才转换为上游现有 `cli4.hahaxiong.cc` authority；原生Cookie签名与API/WS认证不变。公网 Cookie 继续 Secure，mesh HTTP Cookie 为 HttpOnly/SameSite=Strict/30天，不能设置 Secure。跨站及其他Host被403拒绝，匿名API/WS仍401。

公网密码网关改用相同直连启动器，仅重载该网关并完成浏览器回归；未重启DSH和隧道。mesh网关加入时或VIP暂不可用时由launchd KeepAlive/ThrottleInterval=15恢复；未做整机重启或故意断网演练。

定向删除 Mini 持续重试的废弃 `udp://207.57.124.191:11010` connector，同时从配置删除对应唯一peer段。有效UDP22、TCP443及现有LAN连接保留。配置私有备份：`/etc/easytier/node.toml.before-deepseek-mesh-20261019T114025`，root0600；没有输出或提交网络密钥。

## 浏览器兼容问题

HTTP 私有IP不是浏览器安全上下文。首次真实验收发现Bot主面板因 `crypto.randomUUID is not a function` 崩溃，但密码、静态资源与WS已正常。仅mesh首页在应用加载前注入 `/_mesh/compat.js`，用 `crypto.getRandomValues` 生成RFC4122 UUIDv4；不覆盖已有实现，不使用Math.random，不修改DSH依赖源码。公网HTML不注入。

## 验收

| 检查 | 结果 |
|---|---|
| 网关自动测试 | 11/11通过；包括mesh/公网Cookie差异、UUID、安全边界、WS匿名/授权/跨站 |
| Mesh WebKit | 密码页、错误拒绝、正确登录、15Bot、WS、30天Cookie、关闭重开免登录、退出全部通过；pageerror 0 |
| 公网回归 | 同上全部通过，Secure与子路径Cookie保持 |
| Air实际认证访问 | 11:47:40–11:50:31，18/18成功；中位18.6ms，最大34.5ms |
| Air实际大文件 | 8,675,461字节/0.3171s；9,198,843字节/0.3718s；均200 |
| Studio mesh浏览器 | 约3分钟，18/18认证HTTP成功；1条WS零断开、17帧，15Bot保持可见，错误0 |
| Air→Mini路由 | EasyTier实测P2P/tcp，末次lat约7.34ms；不是用ICMP代替网页验证 |
| 服务连续性 | DSH和隧道PID/runs未变，没有发送业务消息或重复模型调用 |

Air资源检查初版未解码HTML中的 `&amp;`，另单独请求未列入manifest的插件路径遭拒；修正为浏览器真实加载的合并资源路径后全部200。这两项是探测脚本错误，不计为18次连续网页观测的服务掉线。

原始截图/报告在本机忽略目录 `output/mesh/`，不含凭据的汇总写入此文；运行数据、Cookie、密码、RTF和网络配置不进Git。浏览器自动化在Studio，Air实测为原生HTTP客户端，不冒称Air浏览器人工验收。

## 运维与回滚

```bash
ssh mini-tb 'launchctl print gui/501/com.mycc.deepseekbot-mesh'
# 仅重启mesh入口，不重启模型任务
ssh mini-tb 'launchctl kickstart -k gui/501/com.mycc.deepseekbot-mesh'
# 停用mesh入口后继续用公网
ssh mini-tb 'launchctl bootout gui/501/com.mycc.deepseekbot-mesh'
```

要永久停用mesh还需移走对应LaunchAgent plist，保留数据与密码哈希。网关/启动器变更前备份位于 Mini `~/local/deepseekbot/private-backups/mesh-web-20261019/`。回滚时仅恢复本次文件，按实际需要重载网关；不要为了回滚网页入口重启正在运行的Host。

当前Air P2P路径减少公网Nginx、SSH中转及香港访问依赖，更适合日常使用；异地切换网络后仍可能改走中继，Mini睡眠/断网或本地网络故障也会中断。官方说明：[P2P优化](https://easytier.rs/guide/network/p2p-optimize)、[配置与默认加密](https://easytier.rs/en/guide/network/configurations.html)。
