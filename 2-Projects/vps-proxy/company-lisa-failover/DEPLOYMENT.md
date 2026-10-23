# 公司 Lisa 容灾：首批上线记录与后续门禁

时间：2026-10-23，北京时间。状态：**Studio 与 Air 已上线；home 两个隔离备用入口已上线；Mini/dev198未部署。**

## 授权与任务保护

用户批准按三层优先级、逐设备灰度方案实施，并明确“等任务结束再接线”。
Studio原Codeg任务 `01a15dd8-1789-7a01-8157-dd302ca644db` 于11:45:36完成，随后多次确认Codeg无in_progress，12:09才执行首次Xray重载。Codeg没有重启，真实监听进程仍53748；原账户auth与Codex配置哈希未变。这里只记录本次观察，不把PID当永久真值。

## 已部署

| 位置 | 内容 |
|---|---|
| Studio | 原127.0.0.1:10808入口保持；原私网直连规则保持；原Lisa兜底规则改接`cf-lisa` |
| Studio | 新出站`cf-dmit`、`cf-zgo`、`cf-home`、`cf-block`；原出站保留 |
| Studio | 控制API仅127.0.0.1:14991；固定路径探针仅127.0.0.1:10828/10829/10830 |
| Studio | launchd `com.company.lisa-failover`，Python标准库控制器；每15秒探测，运行日志1MiB×4轮转 |
| home-studio | 新独立systemd `xray-company-relay.service`，仅10.10.10.23:10810 |
| home-studio | 原生Xray SOCKS密码认证，每设备独立凭据；仅允许10.10.10.11/12/13源IP，私网目标阻断、UDP关闭 |
| home-studio | 出口固定家中已有DMIT IPv6:7443→Lisa节点；不经家中通用balancer。原主Xray及10809转发均未改、未重启 |

凭据单一来源：Air既有`~/.mycc-secrets.env`中的`COMPANY_RELAY_STUDIO_PASS`、`COMPANY_RELAY_MINI_PASS`、`COMPANY_RELAY_DEV198_PASS`。值不在代码、报告或Git。home的实际Xray配置root:xray 0640，目录0750。Studio实际配置0600；临时canary及部署stage已清理。

## 验证与边界

- **52项离线单元/部署mock测试全通过**：优先级、连续失败、恢复保持、防抖、全失败block、规则范围、API读回、活动任务门禁、漂移保护、回滚中止恢复控制器等。评审发现的问题已修复；mock不等同真实故障演练。
- 隔离Xray实例做真实blackhole故障注入，验证主路径失效、前两路失效、全部失效及恢复。由于ZGO当时也有自然超时，主路径故障后的实测选择曾直接跳到home，这是“只选当轮健康候选”的预期行为，而非必定机械经过ZGO。
- 隔离真实API选路与目标TLS/HTTP已验证三路可达；首轮home曾有一次超时，复测home实际主入口4/4成功。
- 安全负例：未认证SOCKS拒绝；Air即便使用有效凭据也不能经该入口代理；公司合法源通过该入口访问127.0.0.1目标被阻断。
- 上线后原10808入口Codex目标探测3/3成功；Codeg authenticated GET /health HTTP200，32ms。
- 同一Codeg bundled native core0.160.1，以现有官方账号的access token作临时隔离、refresh token留空、只读/no-tool测试：`gpt-6-astra/high/priority`完整完成，15.17秒，回显验收标记、零工具调用；未动真实会话。
- 上线初始8轮：DMIT 8/8、home 8/8，ZGO 3/8。**ZGO仍有间歇超时，不能称所有链路稳定；不可用时控制器会跳过。**
- 12:13复核累计15轮：DMIT 15/15、home 14/15、ZGO 6/15；状态OK、采样3秒新鲜。home也有偶发单轮失败，不能包装成绝对稳定。
- 当前优先出口DMIT；初始化block→DMIT计作一次切换，并非故障切换。
- 短探针/短推理不证明长SSE稳定；原有连接不迁移，故障时仍需要应用重连。所有路径最终依赖Lisa，无法覆盖Lisa本身整体故障。

## 运行、手动固定、回滚

Studio运行目录：`/Users/fu-121/xray/company-lisa-failover/`。
状态：`state.json`，日志`state.log`，备份`backup-config.json`，清单`manifest.json`。

```sh
# 在Studio执行；下列配置均不含操作所需认证凭据
/usr/bin/python3 -B /Users/fu-121/xray/company-lisa-failover/controller.py --config /Users/fu-121/xray/company-lisa-failover/controller.json --status
# 限时固定某一路（仍拒绝使用探测失败的路径）
/usr/bin/python3 -B /Users/fu-121/xray/company-lisa-failover/controller.py --config /Users/fu-121/xray/company-lisa-failover/controller.json --pin home --duration 900
# 恢复自动
/usr/bin/python3 -B /Users/fu-121/xray/company-lisa-failover/controller.py --config /Users/fu-121/xray/company-lisa-failover/controller.json --pin auto
```

回滚须在任务空闲且获准维护时，用既有秘密存储中的Studio管理员凭据经stdin认证sudo，运行`/Users/fu-121/xray/company-lisa-failover/rollback_studio.py`；不把密码放argv。脚本校验当前配置/备份哈希与活动任务，停止控制器，恢复原配置，只重载原Xray。若中途漂移/任务出现，恢复原控制器并中止；控制器有生产配置哈希门禁，防止修改异主配置。不要盲目覆盖冲突或仅停止控制器便宣称已回滚。回滚会断开旧代理连接，必须复验Codeg及实际模型调用。

home独立入口如需停用，仅停`xray-company-relay.service`，不要重启`xray.service`或改原10809白名单。凭据撤销/轮换另需用户明确授权。

## 观察与后续实施

已建立本聊天heartbeat“Studio 代理容灾试点观察”（ID `studio`），每15分钟只读检查；原生控制器本身每15秒选路。无异常不例行通知。观察截止不早于**2026-10-26周一12:15北京时间**，届时汇总工作日证据并暂停观察自动化；不自动改其他生产机。

推广前要求：无持续ALL_DOWN/CONTROL_ERROR，无异常频繁切换；近期真实推理可用，收集至少一次真实长任务结果；确认回滚与维护窗口。不能只看服务active或401。

- **Mini**：已有Lisa专属规则，真实节点已偏向ZGO；仅替换精确Lisa规则，不碰GitHub、Gemini、H-xAI、国内直连或其他业务出口。适配其launchd所有者，生产任务零in-flight后再应用。
- **dev198**：当前`main-balancer`是ZGO/其他代理+Mini，**没有Lisa规则**。不能把整个main-balancer替换掉；需先明确哪些业务域名应进入Lisa组（特别是H平台），其余维持原样。后续部署以user systemd适配，不要求无谓sudo。
- **Air**：已按下面的独立扩展加入试点；不是全局代理重写。

## 代码与留存

代码位于隔离工作树的本目录。部署时尚未提交；随后用户明确要求并授权本次codex代commit+push，已进行skill、共享记忆与复盘收口；发布分支与最终Git回执见收口报告。保留工作树供试点和后续推广使用；不要提前archive。真实运行配置、备份与认证文件不应复制入仓库。

Xray官方依据：[RoutingService](https://github.com/xtls/xray-docs-next/blob/main/docs/en/config/api.md)、[Balancer](https://github.com/xtls/xray-docs-next/blob/main/docs/en/config/routing.md)；`api bo/bi`已用各机26.3.27原生CLI验证，不仅依据文档。

## Air 扩展实录（2026-10-23 13:30）

用户确认 Air 在公司网络并授权纳入容灾。13:30:29 完成第二次接线，未重启 ChatGPT（主进程35490未变），原 Codex auth/config 哈希前后相同，系统代理仍127.0.0.1:10808。

- 精确替换原 `admin-LISA-DMIT-11443` 的4条规则，原出站、其他规则与GitHub balancer逐项比较保持不变；原 `admin-LISA-ZGO-12443` 的X/Grok分流不变。
- 本机用户级 `gui/501/com.company.lisa-failover` 控制器、`gui/501/com.company.lisa-home-tunnel` 隧道；原 `gui/501/com.xray.proxy` 仅在首次部署/回滚重载，平时通过API改新连接选路。
- Air运行目录 `/Users/rayman.chen/xray/company-lisa-failover/`，包含配置备份、哈希清单、状态、探针验收回执；实际含凭据配置不入仓库。秘密指针 `COMPANY_RELAY_AIR_PASS` 在既有本机秘密文件，未轮换原凭据。
- 家中独立 `xray-air-relay.service`，配置 `/usr/local/etc/xray-air-relay/config.json`，只监听127.0.0.1:10811，独立SOCKS认证。Air以严格hostkey校验的已授权SSH，把127.0.0.1:10832转发到该端口；断线由launchd重连。家中原Xray与公司10810 relay进程均未变。
- 初测发现Air连接mesh入口时，客户端源为10.10.10.31，home观察到的源却为10.10.10.23，原精确来源白名单因此拒绝。未放宽来源到整个mesh或home地址，改用SSH加loopback独立入口。其初始mesh配置已备份为root-only `config.before-ssh.json`，现已关闭mesh10811监听。

验证：
1. 隔离实例三条路径各3轮204/401均通过，真实API逐一选择DMIT/ZGO/home均可达，block拒绝，SOCKS无认证拒绝。复测HTTP mixed入口DMIT3/3、ZGO3/3、home2/3（一次7秒超时），表明home也不是绝对稳定。
2. 首次生产接线13:22入口验收未达2/3，安装器自动恢复原配置并清理自有launchd接线；字节比较确认已回滚。首次代码未留逐次响应码，不能把原因断言为某个节点故障。随后增加逐次exit/http回执，经隔离HTTP路径复测后再次接线；13:30入口验收3/3成功，回执`entry-probes.json`。原失败记录保存在本机`company-lisa-air-rolled-back-20261023-133010`，不得拿旧状态误认为在运行。
3. Air原生core0.163.0-alpha.11，临时隔离现有官方access token（refresh token留空），gpt-6-astra/high/priority真实完整推理13.37秒通过，零工具调用，未改真实会话。新access日志证明原入口ChatGPT流量命中cf-dmit。
4. 原52项离线测试通过；收口新增test_air_ops.py的8项回归，总60项通过；另做Air回滚纯内存mock，验证第一次kickstart失败后旧配置可再次恢复、控制器未加载状态可识别、配置漂移仍阻断。回滚重试修复经独立只读审查通过。
5. 初始3轮：DMIT2通过/1失败，ZGO2/1，home3/0。不要由这几轮断言长SSE稳定；故障时旧连接仍需应用重连。三路共享Lisa末端，不能覆盖其整体故障。

Air只在获准维护窗口回滚：
```sh
/usr/bin/python3 -B /Users/rayman.chen/xray/company-lisa-failover/air_ops.py rollback
```
该操作检查配置与备份哈希，只停自有控制器，恢复原Xray配置并重载；重载成功后才卸载隧道/plist。若重载失败，允许配置已是原版本时再次执行，避免无法重试恢复。遇配置漂移停止，不强覆盖。备份保留；home独立relay停用另行授权，不动公司10810或主Xray。

既有观察自动化`studio`已更名“Studio / Air 代理容灾试点观察”，保持15分钟只读、健康安静，观察截止不早于2026-10-26 12:15。不自动推广Mini/dev198。
