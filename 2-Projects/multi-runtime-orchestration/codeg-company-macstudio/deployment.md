# 公司 Mac Studio Codeg 部署验收

完成时间：2026-10-08 11:33 CST。已部署、已验收；未 commit/push。公司 Mac Studio M2 Max，macOS 26.4.1 ARM64，用户 fu-121（UID 501）。

## 实际结果

官方 Codeg Server 0.34.0 安装于公司 Studio 的 `~/mycc/2-Projects/multi-runtime-orchestration/codeg-company-macstudio/releases/0.34.0`，current 指向该版本。官方 archive SHA256 `723b43eb81ce05e805a1ed4ef4eb54dddeb58f420ee8323a0f340e625ba71e76`；对应官方摘要、归档及 trusted-comment 签名、key ID 在独立下载中验证，Studio 对同 SHA 包验证，binary codesign 验证退出 0。

系统 LaunchDaemon `/Library/LaunchDaemons/cc.codeg-company-studio.plist` 已 enable/bootstrap，system domain 实际 running，RunAtLoad/KeepAlive 已生效。root 所有 runner `/Library/Application Support/Codeg-company-studio/runner.py` 只先读取专用 System Keychain 条目，然后 initgroups/setgid/setuid 降为 fu-121；server、supervisor 与 runner 实测均 UID 501。运行同一 launchd 进程组，防止守护程序被 SIGKILL 后残留服务占端口；官方 `--supervise` 保留其升级试运行/回退机制，外层 launchd 负责故障退出重启。

监听仅 `127.0.0.1:3080`。`CODEG_HOME` 与 `CODEG_DATA_DIR` 同为 `~/Library/Application Support/Codeg-company-studio`（0700），隔离家里的实例。日志在该目录 logs/service.log（0600，5 MiB×4份上限）；启动日志 `/var/log/codeg-company-studio.launchd.log` 为 root 所有 0600。server 启动会输出 token，runner 在落日志前过滤实际值。

机器已有 sleep=0/autorestart=1；未更改全局电源设置，服务生命周期额外使用 caffeinate -is。完整整机重启未执行。现有 xray 为 `com.xray.proxy` 用户 LaunchAgent，本次未迁移；模型代理在未登录桌面时的可用性未验证，不应宣称已验完整无人值守模型调用。

## Air 使用入口

Air 固定入口为 **http://127.0.0.1:13080**，桌面双击 **公司 Studio Codeg.command**；脚本检查连接、从 Air 已有秘密文件的专用键读取 token，仅交给 pbcopy，再打开正常网页。首次登录粘贴一次，官方网页按 origin 记住登录。

Air `gui/501/cc.codeg-company-studio-tunnel` LaunchAgent 自启/保活。优先已有 `ssh studio` 局域网别名；不可达或连接退出时使用已有 `studio-pub`（经 mini-pub）。专用隧道禁用 ControlMaster/ControlPath/ControlPersist，SSH 前台运行，避免复用用户其他 SSH master 后端口和生命周期失去归属。未安装 Air 桌面 App，也未改 SSH 别名/host key 信任。

Air 入口源文件在 `~/mycc/2-Projects/multi-runtime-orchestration/codeg-company-macstudio/`；登录凭据只在 Air **既有** `~/.mycc-secrets.env` 专用键 `CODEG_COMPANY_STUDIO_TOKEN`，以及 Studio System Keychain `codeg.company-macstudio.server` / account fu-121。凭据值不进 URL、Git、记忆或报告；未替换既有凭据。

## 实际验证

- 身份与进程：公司主机、UID501、system job、单一 loopback listener 和相同 PGID 均核对。
- 认证：正确 token 获非空 JSON `status=ok, version=0.34.0`；缺/错误 token 两个负锚均401。
- 前端：真实 HTML 372255 bytes；其实际引用 JS 40413 bytes 返回正确类型，未只凭状态码判断。
- worker SIGKILL：0.617 秒恢复，新 worker 与 launcher PID，鉴权健康恢复。
- launcher SIGKILL：10.758 秒恢复，旧 worker 被 launchd 同组清理，新单实例监听恢复。
- Air SSH SIGKILL：2.314 秒恢复，备用公网路径新 SSH PID+鉴权 API 成功；再次 kickstart -k 后回到局域网优先路径。
- Codex：复用原生0.156.0，通过正常 Codeg 安装API准备官方 codex-acp2.1.1。API→WS attach→prompt 实际调用工具执行 pwd/id-u/hostname/读取自建随机 nonce；prompt 不含 nonce。回读路径、UID501、公司 hostname 和 nonce 全匹配，73个 content_delta 与 turn_complete(end_turn)，约20.567秒。该数字是一次短任务功能验证，不是长上下文/并发性能。测试连接、Codeg会话、工作区已关闭/软删除，/tmp测试文件删除。
- 专用服务日志与隧道日志精确扫描，没有实际 token 值。

## 本轮故障与修正

npm 官方仓库经过本机10808代理12秒超时，直连约1.74秒获得完整非空元数据。仅把 registry.npmjs.org 加入服务的 NO_PROXY/no_proxy；没有重写全局 npm 设置、现有模型代理或凭据。官方首次适配器安装API没有整体超时/取消，HTTP超时不能证明npm已停止；受控卸载本服务后确认原npm进程随组退出，再通过正常API重试并核adapter_installed=true。

首次隧道实现同时存在独立进程组残留与SSH ControlMaster复用两个归属问题。前者由同 launchd PG 修正；后者用专用隧道禁复用修正。遗留共享 master 上仅取消本任务13080转发，没有杀共享 master。故障路径用实际SIGKILL/端口/新PID/非空鉴权API重新验证，不能只检查plist KeepAlive。

## 后续维护（给 agent）

Studio查询：`sudo launchctl print system/cc.codeg-company-studio`。平稳停止：`sudo launchctl bootout system/cc.codeg-company-studio`；彻底禁用另执行 `sudo launchctl disable system/cc.codeg-company-studio`。恢复：enable该label，再bootstrap system对应plist；检查唯一3080 listener与鉴权health。维护重启可kickstart -k同label；请先确认无正在工作的连接。

Air查询：`launchctl print gui/$(id -u)/cc.codeg-company-studio-tunnel`。停/恢复用同gui label的bootout/bootstrap。无需停止、改写或删除已有studio/studio-pub/mini-pub SSH服务。

root runner源版本SHA `d886f50fbe0b4ba5c862448371c2f883495de3bcceaefad02927f62750686b5e`；Air隧道SHA `d7ef040ecd75a2528daf64398403fad04f15d9dbed7d993bb94d5efb6690314d`。替换root runner必须核旧SHA、原子替换、root所有路径及无group/world写权限，绝不能让root daemon执行用户可替换的项目内脚本。旧初次runner备份仅供比对，含已修复边界，不建议回退该版。证据见deployment-validation.json。
