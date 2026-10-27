# Air 受管界面与运行态维护包（2026-10-27）

本目录是本次Air维护版的源码入口，含无凭据脚本与离线回归；不含生产config/controller配置、节点凭据或个人日志。仓库中的候选、生产部署和线上验收是不同状态；是否已部署以对应回执与manifest为准，不凭文件日期推断。

## 源码与部署文件

| 文件 | Air目标 | 用途 |
|---|---|---|
| `xray-manager.py` | `~/xray/xray-manager.py` | Air历史功能、受管界面、配置写保护和精确launchd操作 |
| `managed_status.py` | `~/xray/managed_status.py` | 界面的只读、脱敏状态采集模块；必须与manager同目录 |
| `rule-updater.py` | `~/xray/rule-updater.py` | 受管资产pending与保inode日志轮转；不是界面升级的重启入口 |
| `routing_policy.py` | `~/xray/routing_policy.py` | 纯函数审计、保首匹配整理、普通均衡组启停计划 |
| `routing_publish.py` | `~/xray/routing_publish.py` | 版本绑定预览、协调guard发布、精确重启与失败回执 |

**Air界面发布须一起核对manager及其三个同目录模块（managed_status、routing_policy、routing_publish）。** 上级 `../xray-manager.py` 是独立跨平台主版本，没有整文件回填Air历史差异；不能拿它覆盖本包或生产文件。保留Air既有 `easytier_manager.py` 扩展及其他服务，不在本包复制凭据配置。

controller项目入口为 [`company-lisa-failover`](../../vps-proxy/company-lisa-failover/README.md)，生产运行目录为 `~/xray/company-lisa-failover/`。历史Air工作树不是所有机器的固定源码路径，使用前核当前checkout和运行SHA。

## 界面如何判断状态

- `/api/managed-status`只读查询精确controller LaunchAgent和RoutingService `bi`，结合state时间戳。状态新鲜度上限45秒；缺失、损坏、过期、进程不明或控制面异常不显示探测正常，不拿旧selected冒充实时出口。
- 网络总体区分`healthy/degraded/blocked/stale/error/unavailable`；三路探针的业务成功与部分可达分开。pin显示指定路由和剩余TTL；过期pin不冒称仍在强制执行。
- 静态selector/fallback的`cf-block`单独标注。只有有效实际override才报告确认的出口；空override不会拿磁盘默认值填成“当前出站”。路由列表展示balancer目标、inbound等限制，避免把配置目标当运行证据。
- pending依据持久marker展示`pending_until_verified`；标记不存在只表示“无待确认记录”，不等于资源已生效。标记损坏显示未知/错误，不根据旧updater状态或PID变化自动变绿。
- 第二阶段起，受管或状态尚未确认时，节点增删改、链接/订阅导入、端口、均衡组和路由的独立写入口锁定。第三阶段仅增加下文的受控预览/发布入口，原独立写接口与HTTP409保护继续保留；错误不能继续关弹窗、显示成功或触发重启。查看、日志和TCP测试保留；TCP测试仅测端点建立连接，不能证明经代理访问目标业务成功。

实际Air的`bi`输出带缩进和`- `前缀，解析与回归必须使用真实样本，同时覆盖CRLF、空override、外来tag及重复/混合格式，不能只用手造简化文本：

```text
  - Selecting Override:
    1   cf-dmit
  - Selects:
    1   cf-block
```

## 资产更新与日志边界

受管updater只更新磁盘geo资产、不自动HUP或重启Xray，`rule-updater.pending.json`保留到维护验证收口。标记应先于资产替换持久化；下载无变化、PID改变或配置校验通过不足以证明目标资源已加载，不自动清空pending。

受管access/xray日志复制到原子备份后在原fd截断，保inode并验证原描述符继续写入；复制与截断之间可能丢少量日志。其它日志沿用既有策略，不为轮转重启主服务。

## 第二阶段界面文件发布与回退

1. 先读实际LaunchAgent路径、目标两文件SHA和当前服务/配置状态，确认本次拥有的变更范围；生成全部候选并完成离线检查，备份原文件及权限。
2. 写入前重读摘要，冲突则停止并重新合并；先原子写同目录helper，再写manager，最后仅重启 `com.xray.manager` 加载界面。逐文件记录回执，版本检查加原子替换不是跨文件事务。
3. 读回两文件SHA、API和真实8888页面，核原Xray、Grok专用代理与controller身份/健康。界面发布不调用主代理重启/停止，不清pending，不修改生产路由或guard。
4. 失败时只恢复仍属于本次版本的文件并重载manager；保留后续他人修改。需要主Xray维护重启以应用资源时另行验证guard、实际override和目标请求，原有连接不能自动迁移。

通用 `install.sh` 检测到controller配置或LaunchAgent即exit78；本包也不是跨平台安装模板。控制器byte/semantic guard、手动pin和外来override保护继续保留，不用改哈希绕过真实配置漂移。

## 第三阶段：路由整理与均衡组启停（2026-10-27，已部署）

Air管理页于12:58:33部署，真实页面于12:59:28通过受控apply将规则从29条整理为26条；13:00:44独立读回磁盘和管理API均为26条、回执为`applied`。普通组启停已实现，但此次只验证预览，未在生产真正切换备用出口。以下是发布机制与维护边界，故障回退证据来自隔离测试，未在生产注入故障。

- 审计发现29条规则中的原索引10、20、21被前序同目标规则完全覆盖；原索引16中的17个Google条件被原索引9的ZGO规则抢先匹配。整理后26条，保留当前首匹配目标、探针规则及其位置、UDP443策略和最终兜底；不会将Google重新改送cf-lisa。原索引3的尾斜杠域名只告警、不擅自纠正。这里索引从0开始。
- 同一字段的重复或被父域/CIDR包含的条目可以缩减；不同字段仍为AND。端口、入站等更窄条件不能覆盖更宽规则，未知条件不作包含推断；regex/geosite/geoip不展开就明确显示未覆盖，不能据此宣称无冲突。配置目标、运行时override和真实请求选路仍是不同证据。
- 普通均衡组停用采用**保留规则条件与位置、将目标转给用户明确选定的既有备用代理或阻断出口**。不隐式直连、不删仍被引用的均衡组。`routing-policy.json`保存原规则、位置、停用结果、组摘要、条目数量与列表摘要；启用前完整核对后精确恢复，漂移或截断拒绝恢复。没有关联规则的组可只改变启停记录。该私有记录用于完整性核验，不是防恶意篡改签名。
- `cf-lisa`由controller独占管理，普通启停入口拒绝操作；不停止controller来模拟停用，不直接抢写其override，不改变静态cf-block、pin或获准出口。存在停用组时拒绝整理，避免破坏恢复位置。
- `/api/routing-policy/preview`在私有目录生成版本绑定候选，执行Xray配置测试；预览不修改现役三份配置或操作服务。应用必须使用仍有效的预览标识，重核配置、controller、启停记录、pin、程序、LaunchAgent与geo资产摘要，发现漂移即停止。
- `/api/routing-policy/apply`是**实际维护发布**：同步写路由配置、完整guard与启停记录，精确重启主Xray并恢复controller。它会中断旧连接，不承诺零中断。验收须确认新主进程、实际override、controller新鲜健康和业务探针，以及独立Grok实例未被重启；仅磁盘写成功、PID变化或`run -test`通过均不能标成`applied`。
- `.routing-publish/active.json`指向本次私有journal及原件/候选。失败只恢复仍属于本次版本的文件；遇外部修改、外来override或恢复证据不足，保留现场并显示`recovery_required`。即使best-effort恢复controller，也不能冒称回退已验证。未完成记录阻止下一次发布；若发布进程被强杀或机器断电，需人工按journal恢复，本版没有自动崩溃恢复守护。主配置原件可能含凭据，只存Air受限目录，不进入Git或公开接口。
- 本流程**不自动清除资源pending**。发布窗口内geo资产漂移必须被发现；重启本身不能证明加载了预览绑定的资产。后续独立updater仅写磁盘的pending，与先前运行实例的发布回执分开解释。

独立首匹配审查使用实际29条脱敏规则生成18,220个域名/IP、网络、端口与入站组合：16,684个可证明样本前后目标相同，1,536个因资源库/未知条件未覆盖。另有21项独立回归覆盖域名边界、AND、更窄条件、跨目标死分支、准确恢复、漂移/截断拒绝及脱敏；这不是对全流量的形式化证明。Air完整配置仅在内存试算得到29→26、审计error=0，未由该检查写入生产。

13:00:44现场回执记录主Xray PID8084、controller PID8092、独立Grok PID76341保持，实际override为`cf-dmit`，Google204/Codex401均exit0；再次整理预览为0项变更并禁止应用。配置SHA为`22d659681abf2a8c991cccbdc014aa0b7374889206de3d7892b0343861184e8f`，资源pending保持。部署备份在Air `~/.local/state/chatgpt-repair/routing-ui-20261027-125741/`，发布journal在`~/xray/.routing-publish/previews/2ohWAMWvZXq3h925-oBCtoWVk9vrDR7U/`；原件含敏感配置，只留Air私有目录。PID和摘要是该时刻回执，不是永久设备常量。

最终刷新修复阻止发布前旧请求与同类乱序响应覆盖新列表，所有列表刷新结束才解锁；刷新失败清除旧列表并提示重试。最终168项Python、46项JS、两套Chromium fixture通过，13:23真实页面渲染26条、零pageerror。最终仅管理页重载时间见manifest。

## 离线验证

在本目录运行：

```bash
/usr/bin/python3 -B -m unittest discover -v
node test_manager_ui.js xray-manager.py
node test_managed_ui.js xray-manager.py
node test_routing_ui.js xray-manager.py
# 第三阶段的独立首匹配审查；真实Air样本缺失时该项明确skip
/usr/bin/python3 -B -m unittest -v test_routing_policy_review.py
# 可选：已有 Playwright 与浏览器时，环境变量指向其现有路径；不安装依赖
node test_browser_ui.cjs
node test_routing_browser.cjs
```

2026-10-27 12:20为第二阶段Air页面验收，第三阶段12:59:28规则应用与13:00:44独立核验另有回执，详情见[复盘与防复发](复盘与防复发.md)。源码摘要、部署摘要和历史运行基线分别保存，manifest不能用候选摘要冒充现役摘要。

上级安装器守护测试为 `test_install_guard.py`，仅使用临时HOME与命令拦截；不执行真实安装。用实际解释器复跑，测试总数及生产验证以当次回执为准。文件摘要见 `manifest.json`，UI截图/状态快照不能代替部署后的新读回，也不代表长SSE或一个工作日稳定性已验收。
