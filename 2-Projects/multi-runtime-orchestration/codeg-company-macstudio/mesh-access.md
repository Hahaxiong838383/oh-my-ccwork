# 公司 Mac Studio Codeg：EasyTier 远端工作区

当前状态：2026-10-08 11:51 CST 已开放 Codeg 官方内网监听，并从 Air 实际通过 EasyTier 访问公司 Mac Studio。此状态取代 11:36 安装报告里的“只监听 loopback”；原验收证据保留作历史。

## Air Codeg 0.34.0 配置

| 字段 | 值 |
|---|---|
| 名称 | 公司 MacStudio |
| 服务地址 | http://10.10.10.12:3080 |
| 访问 Token | 沿用既有原始 Token；Air ~/.mycc-secrets.env 的 CODEG_COMPANY_STUDIO_TOKEN（只存指针） |
| 自定义请求头 | 留空 |

入口：左下快捷操作 → 打开远端工作区 → 管理远端工作区 → 新建连接。服务地址不带 /api 或 /ws/events，不使用 ws://。Token 不加Bearer或Base64；官方客户端自动处理HTTP鉴权、派生WS地址和Token子协议。Token值仅交付本人，不写此文档、Git或记忆。

## 实际网络与部署

- Studio EasyTier VIP `10.10.10.12` 在 utun0；Air 到该IP走utun4，SSH真实banner正常；`10.10.61.177`子网映射也可达，但首选Studio自己的VIP。
- 公司 Studio 所有现有 IPv4接口为私网/loopback/link-local。将可信root runner中的 CODEG_HOST 按官方机制设为0.0.0.0，仅监听IPv4；实际lsof为 `*:3080`，server仍UID501。该监听同时覆盖局域网、EasyTier和loopback，并非仅绑定Mesh。
- 服务 NO_PROXY/no_proxy 追加10.10.10.12和既有三组内网网段，保留npm官方仓库直连例外。其他引擎/数据/鉴权/启动机制不变。
- 变更前Codeg连接列表为空，受控bootout→确认旧job/端口消失→root原子替换runner→bootstrap。前一版备份在 `/Library/Application Support/Codeg-company-studio/runner.py.pre-mesh-20261008`。KeepAlive、日志过滤、System Keychain和普通用户运行均保留。
- 旧Air SSH入口 http://127.0.0.1:13080 继续可用；无需经公网跳板连接新VIP地址，但两端EasyTier应在线。

## 当前验收

Air直接通过VIP POST /api/health获得真实非空 status=ok/version=0.34.0；缺/错误Token均401。无Origin（官方native Rust客户端实际形态）、tauri://localhost及HTTP网页Origin三种WS升级均101，均收到__ready__。Codex官方预检passed且codex-acp adapter_installed=true。原loopback health和Air13080页面仍可用。此轮验证网络入口/鉴权/WS，不重新宣称做过整机重启或新的长任务性能测试。

当前root runner SHA256：`00e2b480309d040489e5b2b5ed8472677c788808b6d57d58f0916366b6e8ffc0`；证据 [mesh-access-validation.json](mesh-access-validation.json)。先前部署及进程保活验收见deployment.md/deployment-validation.json；最新监听状态以本文及mesh证据为准。
