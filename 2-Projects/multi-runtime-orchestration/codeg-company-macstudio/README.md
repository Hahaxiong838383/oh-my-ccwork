# 公司 Mac Studio Codeg Server

2026-10-08 已安装官方 macOS ARM64 Codeg Server 0.34.0，系统自启、故障退出自动重启和真实 Codex 远端命令验收均通过。目标是公司 `fu-121deMac-Studio.local`（Mac Studio M2 Max），与家里的 Ubuntu `home-studio` 分开。

**15:16 CST 最新状态：服务进程仍在，但 HTTP 请求不响应。** 只读诊断定位目录选择器同步读取 Desktop 时等待 macOS 文件夹访问权限；尚未恢复。见 [远端工作区失败诊断](2026-10-08-remote-workspace-hang.md)。以下部署及四档验证为此前阶段的验收记录。

- [部署、接入与维护](deployment.md)
- [脱敏验收证据](deployment-validation.json)
- `runner.py` / `cc.codeg-company-studio.plist`：公司 Studio 的已部署版本源文件；实际 runner 位于 root 所有的系统目录。
- `air-tunnel.py` / `open-codeg.py` / `cc.codeg-company-studio-tunnel.plist` / `Open-Company-Codeg.command`：Air 固定入口、自启隧道、启动接线及首次登录便利入口。
- `validate-service.py`：当前 `*:3080` 服务的只读健康/鉴权/前端/进程/日志验收；仅显式 `--test-recovery` 才做强制退出测试，须维护窗口且无用户连接。`codex-probe.mjs` 保留实际工具回合验收。
- `sync-grok-capabilities.py`（Python 3.11+）：读取当前 Grok 配置检查四档，默认只读；显式 `--apply` 才经 Codeg 官方接口修复元数据，保留其他配置与凭据。这两个更新后的维护脚本已静态审查，尚未在当前挂起的生产服务上实跑。

Codeg 服务 Token 仅存公司 Studio System Keychain 和 Air 已有批准的 0600 凭据文件；个人 CPA/Xray 凭据保留在各自既有 0600 运行配置。本目录不保存凭据；下载、解包及缓存产物忽略 Git。

## EasyTier 远端工作区接入（2026-10-08 11:51 CST 更新）

当前公司入口 **http://10.10.10.12:3080**；Codeg官方IPv4监听已改为0.0.0.0，兼容原loopback/SSH入口。当前源版本和脱敏验证见 [mesh-access.md](mesh-access.md) 与 [mesh-access-validation.json](mesh-access-validation.json)。此前deployment报告中只监听loopback的状态属历史。

## 固定 Lisa 出站（2026-10-08 更新）

Xray 已迁移为系统 `com.xray.proxy.studio`，默认与所有公网路由固定 Lisa；Codeg、系统代理和启动环境已统一，真实出口为 `154.44.3.170`（洛杉矶）。当前 source 与恢复记录见 [固定 Lisa 出站](2026-10-08-lisa-outbound.md) 和 [脱敏验收证据](lisa-outbound-validation.json)。此前用户登录 Xray 与 npm 公网豁免的记录为历史状态。

## Grok 个人 CPA 接入修复（2026-10-08 更新）

Grok 已通过官方配置接口接入 `smart-api.hahaxiong.top/v1` 的 `grok-4.7`（Responses）。新连接默认模型与实际对话完成已验证；原表单在模型 ID 空时会丢弃接口字段。原因、配置与复验方法见 [修复记录](2026-10-08-grok-cpa.md) 和 [脱敏验证](2026-10-08-grok-cpa-validation.json)。

## Grok 推理强度选择（2026-10-08 更新）

自定义模型已补齐 **Low/Medium/High/Max 四档**，最高协议值为 `xhigh`，默认 High；最高档真实 CPA/Codeg 对话与生产网页 Max→High 点选回读通过。已有旧 Grok 会话点黄色提示中的“重连以应用”加载能力，历史保留。最新见 [四档修复记录](2026-10-08-grok-xhigh.md) 与 [脱敏验收](2026-10-08-grok-xhigh-validation.json)；原三档记录是此前阶段。
