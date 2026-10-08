# 公司 Mac Studio 固定 Lisa 出站（2026-10-08）

当前公司 Studio 的 Xray、系统代理、Codeg 运行环境已统一走用户指定的 `admin-LISA-DMIT-11443`。实际出口为 **154.44.3.170，美国加州洛杉矶**。原配置的旧 DMIT 默认出口、GitHub leastPing/ZGO 分流，以及指向 Mini 的系统代理会造成出口不固定；这些入口已统一。

## 当前配置与保证范围

- 公司目标：`fu-121deMac-Studio.local` / UID 501；不是家里的 Linux `home-studio`。
- 入站：`127.0.0.1:10808` mixed HTTP/SOCKS；指定节点入口 `131.143.181.60:11443`，与用户提供 URI 的所有连接字段在内存中逐项核对一致。凭据只保留在现有 0600 的运行配置，报告不复制 URI。
- Lisa 为第一 outbound，也是公网 TCP/UDP 的最终路由；只有私网域名和私网 IP 两条独立规则直连。只保留 Lisa、direct、block 三个 outbound，无 balancer、其他出口或公网 direct fallback。进入 Xray 的公网请求在 Lisa 故障时失败。
- Xray DNS 为 `https://1.1.1.1/dns-query`，UseIPv4，未设置 local DNS fallback。
- Ethernet、USB Ethernet、Wi-Fi 的 HTTP/HTTPS/SOCKS 系统代理均指本机 10808，PAC/WPAD 关闭，bypass 只保留内网。
- `.zshenv`、`.xray-proxy.sh`、`.zprofile`、GUI 登录环境与飞书 OAuth 保活 job 已清理公网 NO_PROXY 和强制直连旗标；OAuth 定时机制保留。Codeg runner 的 npm 公网豁免也已移除并重启加载。

保证范围是进入 Xray、使用当前系统代理及当前 Codeg/shell 代理环境的公网请求。普通 HTTP/SOCKS 代理不能强制接管忽略代理的程序；本次未启用全机 TUN。已启动 GUI 应用保存的旧进程环境需重新启动应用后才更新。

## 自启、保活与真实验收

Xray 已迁移到 `system/com.xray.proxy.studio`，`UserName=fu-121`、RunAtLoad、KeepAlive；旧用户 `gui/501/com.xray.proxy` 已禁用，原 plist 已备份后移除。只有一个 UID 501 的本机 10808 listener。实际强杀该 listener 后约 **0.343 秒**以新 PID 恢复，恢复后的出口仍为 Lisa。未执行整机重启，因此不声称完整重启流程已验。

验证包含隔离侧车、生产重启后两个独立出口查询、OpenAI/xAI/npm/GitHub/两种 CPA 域名的实际响应与逐域 access tag。npm 返回真实官方 ACP 包元数据；无凭据 API 请求得到真实 401，不能将这些请求当成带凭据模型推理验收。

macOS Foundation URLSession 在无代理环境变量的子进程中，通过系统代理返回 Lisa。四种 zsh 上下文也已回读正确环境。正常 Codeg terminal API＋WS 执行预置只读网络脚本，未指定 --proxy/--noproxy，真实 stdout 的两出口查询均为 Lisa，生产 access log 确认对应标签。Air 仍能经 EasyTier 访问 `http://10.10.10.12:3080`，鉴权 health、缺/错 Token 401、native 无 Origin WS 101＋__ready__ 均通过。

复验还修复了一个本轮代理修改前已存在的 Codex 会话初始化错误。`failed to load workspace requirements` 的真实原因是末尾 `[model_providers.openai] supports_websockets=true` 覆盖内置 provider；当前 Codex 严格加载配置时拒绝这种语义。仅删除这一无效末段，当前模型、provider、权限和凭据沿用。两个独立 app-server 入口已复现具体配置错误，原配置 0600 备份只存 Studio root-only 目录。随后正常 Codeg API＋WS 的真实 Codex 工具回合完成：未将 nonce/IP答案放入 prompt，真实工具输出匹配公司主机、UID 501、默认代理环境与 Lisa 出口，生产日志确认路由标签，收到 end_turn；测试连接/会话/工作区全部清理。此次单个短回合约 28.851 秒，不代表长任务或并发性能。

## 源码、备份与恢复边界

- [脱敏验收证据](lisa-outbound-validation.json)
- [当前系统 Xray plist](com.xray.proxy.studio.plist)
- `runner.py` 是当前实际 Codeg runner 的源文件，SHA256 `ece3ed45d3ee5a4af7e05cc55267261e6b8ba4f54dd9caf4e801c5af485b447f`，取代同日 mesh 接入时的旧版本。
- 生产 Xray config SHA256 `ebb02a5bf7f7191b6a92db57d806a8bfc80d1e13a14f3ae908220c20b13b9e79`。
- 原始 config/plist/环境文件和系统代理快照只存 Studio 的 root-only `/Library/Application Support/Codeg-company-studio/xray-backups/20261008-121833/`；备份含运行凭据，不复制入 Git/记忆。
- 维护恢复必须先确认无活动 ACP 回合；root runner 在其可信 root 目录内原子写入、独立核对规划内容 SHA 和路径权限；不得用用户可替换的目录暂存 root 启动器。Xray 自检应降 UID 501 执行。

本目录早先 deployment/mesh-access 的状态是历史记录。本报告与当前 runner/plist 为本轮最新代理真值。未 commit/push。
