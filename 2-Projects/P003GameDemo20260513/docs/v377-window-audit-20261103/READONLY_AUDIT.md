# v377 埋点窗口：会话48只读核验与对账说明

结论：服务器本次诊断授权已独立核实，可等端侧真实联调；“新请求立即网络上传”不成立。未取得v377真机闭环，不判通过。

## 独立读回（2026-11-03 12:27:16 CST）
|项目|读回|
|---|---|
|MCU/Device Bearer sub尾号|03800006（不是ADB号）|
|总闸/有效准入|true/valid，allowlist仅该设备，目标active/upload=true|
|配置revision|cfg-66；服务端上传policy revision另为1，不混用|
|日批|北京时间23:00|
|分层/聚合/gzip/capture/on-demand-upload|均true|
|诊断request_id|diag-121d6b4b-a9ed-43b2-975c-786542d8b9ae|
|实际创建/到期|2026-11-03 12:25:50.775 → 23:29:59.775 CST|
|累计新样本额度/回溯/来源|1000条 / 收到时向前3天 / 14类白名单来源|
|旧请求|此前已过期；创建本次请求时被明确撤销|
|接收器|ready=true，storage_failures=0，sql_busy=0|
|源码|8个关键在线文件与856552b942f5f8c2feb08db5949ebe7080eff77f完全相同，非声称整套Brain等价|
|范围隔离|相对13的12:23preflight，配置值只变目标请求ID和on_demand_upload_enabled；其他设备/global未变|

本会话只用SQLite mode=ro/query_only及只读接收器接口，**没有调用会进行过期清理的admin tier GET或device-config GET**。无部署、开关写入、合成事件或语音触发。Ark由45单独核；不能用本报告代替其正常模式/钱包/真人问答验收。

## 精确客户端调度结论
已从Git对象35502e7746eed6b5f24e5ba1cfa7d7e263c68a72读取9个文件，逐文件SHA在48-evidence/source-manifest.json。

- `analytics_event_client.gd:140–181` 的flush是Godot→Launcher桥接，非公网HTTP。raw优先，之后闭合aggregate，再sample。
- `P003AnalyticsCoordinator.kt:110–155` handleBridgeData仅持久入队，明确network_upload_scheduled=false。
- `:159–209` onRuntimeConfig只依据总上传enabled、dailyhour、gzip决定调度；换diagnostic request ID不强制网络。
- `P003AnalyticsContracts.kt:122–166`：只有持久元数据previousKnownEnabled=false→true才forceResume。null→true不强制；重启/覆盖安装保数据不制造false，不能当即时flush入口。
- 正常5分钟调度：23点后且今天未完成daily，或Launcher队列最老created_at跨日且今天未完成daily。源事件occurred_at跨日不等于Launcher入队跨日。
- RESUME、CATCHUP不写当日日批完成标记；daily/补传/恢复须按端侧drain_kind独立归因，服务器RID单独无法推断。
- `safeToUpload()`要求无配对、语音交互、本地语音提示、OTA/待重启；忙时延后5min。真正401后的凭据恢复也能恢复，但本轮禁故障注入，不作为操作建议。
- 没有对外公开的强制HTTP flush方法；私有requestUpload不等于可下发的管理命令。即使Godot force flush也只是交队列。

**当前执行口径**：13已选择23:30到期并保留23日批，不再翻总上传。白天可核采样/桥接/配置应用；如确有原有跨日积压可能自然CATCHUP，但不能保证。晚上按实际RID对账。若有人要求15点内网络闭环，必须单独协调已证实的总上传false→true恢复流程；需先有样本入Launcher、设备收到false的证据，再true，仍受安全门；本轮没有执行此流程。

## 额度与到期注意
- 客户端收到request_id和开关，并未收到该请求server max_events/allowed_event_names/expires_at。请求额度100无法约束其最多只发送100；若已有1000个全新合法样本，理论上先100accepted，后900会quota拒收，但真实队列未知，不能认定必900。
- 13选择1000覆盖当前默认Godot缓存1000条/2MiB，合理避免明显首批额度不匹配；它仍是**服务端请求生命周期累计新accepted上限**。Godot移交Launcher后可继续采样，所以两层队列及整个白天累计可能超过1000。无需改现配置，依据真实usage与待传数量判断。
- 已accepted且内容一致的重放优先duplicate，不占新额度；样本ID跨request可重复，不能用请求usage当所有HTTP提交数。
- 到期/撤销按服务端接收时刻对首次样本立即拒收；随后设备配置GET/admin tier GET才清upload/id并提高revision，不依赖定时器才生效。capture不会因为request到期自动false，raw/aggregate总上传和daily23也不会自动关闭。
- 23:30只给正常23点日批约30min，不保证忙碌/离线/长退避场景完成。若23:10仍有待上传或退避已超截止，先报13裁决；禁止擅自续窗/新request/清队列。不能把过期后新样本拒收当“等待下一日可自动补成功”。
- 7天aggregate当前周期按CST epoch锚为10/29–11/5；未闭合桶不上传，今日0桶不构成失败。只用真实已闭合桶验证，禁止改钟/造桶。

## 最小生产API方案（历史设计说明；本轮已经执行，不要再POST）
唯一生产操作者13。受管理员认证的 `/api/admin/analytics/tiering/<目标完整MCU-SN>/requests`：
```json
{"expected_revision":"<操作前即时读取revision>","allowed_event_names":["app.lifecycle_changed","g1.screen_viewed","g1.semantic_interaction","g1.runtime_command_completed","g1.progress_checkpoint","settings.opened","settings.closed","settings.page_viewed","settings.value_changed","network.connectivity_changed","network.provisioning_state_changed","voice.session_state_changed","app.bridge_ready","g1.route_state_loaded"],"ttl_seconds":39849,"max_events":1000,"lookback_days":3}
```
39849仅对应本次实际12:25:50.775→23:29:59.775，不能未来照抄。TTL允许60–86400秒；原100/截至15点方案因上述调度/额度冲突被13替换。
前提tiering+aggregate双真，receiver ready/上传授权有效；CAS409时重新读取，不能覆盖新revision。创建自动capture=true/upload=true/新ID，撤销该设备旧请求，无须额外PUT。返回cfg-66是服务端保存证据，不是端侧已应用。
撤销：`DELETE /api/admin/analytics/tiering/<同SN>/requests/<精确本次ID>`；只撤该请求、清当前upload/id，保留capture和23日批。若要停采，另需13在tier PUT用当时expected_revision将on_demand_capture_enabled=false；本轮48不执行。

## 可执行只读对账
文件 `48-evidence/reconcile-window.py` 已在真实生产以stdin执行，查询仅固定该SN与12:25:50.775起的窗口（最多到授权结束后1小时）；SQLite只读事务、8秒查询预算、明细上限1000/1001，超限显式标记。没有事件正文/凭据输出。
```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 aliyun-hk 'python3 -' < /Users/fu-121/.local/state/p003-v377-coordination-20261103/48-evidence/reconcile-window.py > /Users/fu-121/.local/state/p003-v377-coordination-20261103/48-evidence/reconcile-2310.json
```
按实际取证时刻另起文件，勿覆盖baseline。脚本不会等待23:10或自动安排定时任务；届时须实际执行。

输出覆盖：HTTP RID/attempt/batch/收到时间、ACK三分、settlement原因、raw/aggregate/sample新增入库数、压缩bytes、按诊断ID样本ID与来源、aggregate真实period/count、请求usage。attempt与batch分开，重试可能同batch不同RID；count是源事件数，不等于入库行数。

对账规则：
1. 客户端提供实际APK/PCK与SHA、已应用cfg-66、测试起止、drain_kind、同轮RID/batch及accepted/duplicate/rejected/pending（不发Bearer）。服务端client metadata通常不足以独立证明versionCode377，不用builtin断言已装377。
2. 对每个HTTP attempt，accepted+duplicated+rejected与同RID有效唯一ID结算数相等。仅HTTP200不足够。
3. accepted新增raw+tier行数守恒；duplicate不应新增payload/usage。拒收逐reason回报，不提供源正文。脚本整体和每batch输出可交叉核。
4. diagnostic_request_id来自context，**不等于ana-前缀的HTTP RID**；按两者和attempt联查。新request usage累计不超过1000。
5. aggregate/sample进入独立tier表，不能只查analytics_event便称“0条”。实际period须已闭合；不以当日aggregate0判失败。
6. 服务端到账与客户端pending/死信结算分别取证；过期/限额为逐ID终态拒收，不能算保队列重试。无客户端回执时仅能证明服务器已收。

基线12:28:08：本窗口attempt=0/accepted=0/duplicated=0/rejected=0，tiers/usage均空。零值相等仅说明查账成立，**不是联调PASS**。当日零点旧RID ana-03800006-e7ea198f-37，raw11/0/0，不计本窗口。

## 尚待验收
真机v377 APK/PCK及钱包修复准确版本；配置已应用；日批真实HTTP/压缩；客户端队列结算；Ark normal快照与真实问答；7天节省率。只读脚本成功不替代这些条件。

署名：codex（OpenAI）| 2026-11-03 12:30 CST

## 审计归档补充
主13于12:29追加授权仅提交本轮审计材料。私有SSH/凭据装载脚本和全量配置留协调目录，不入仓。仓内通用只读查询工具为 `reconcile_readonly.py`：数据库路径通过P003_ANALYTICS_AUDIT_DB继承，HMAC设备键通过P003_ANALYTICS_AUDIT_DEVICE_KEY继承；工具不生成/打印凭据，不主动读取.env，不发HTTP、不连接设备。需可信操作者在服务器内装载当前正确HMAC键，环境不可截图或外发。固定request/window避免误查其他窗口。

通用仓内脚本已于 2026-11-03T12:30:45.514404+08:00 通过真实生产只读执行，exit0；本窗口仍0attempt，未验真实上传。`reconcile-public-script.json`为脱敏输出，脚本语法/JSON解析/本次变更范围已核。回滚本次审计提交只删除本目录，不影响生产代码或设备配置；生产request撤销仍由13按精确ID执行。
