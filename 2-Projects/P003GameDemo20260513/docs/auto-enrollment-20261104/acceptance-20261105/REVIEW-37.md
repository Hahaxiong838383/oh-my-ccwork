# 服务端自动接入独立审核37

**最终结论：R1–R7服务端范围全部核验通过，最小意见已全部关闭，无剩余服务端发布或交付阻断。C真机闭环、短信送达及iPhone实测不包含在本结论中。**

|需求|最终结论|已证|边界|
|---|---|---|---|
|R1|PASS_SERVER_SCOPE|受控adapter stdin→HTTP→stdout、重复声明相同，issue/challenge不建registry/key/owner|无必须新增业务接口的阻断；详见证据边界与非阻断脚本加强意见|
|R2|PASS_SERVER_SCOPE|devices.db的registry/key/policy/owner/receipt原子；Brain/accounts/profile后置幂等，故障保留owner并GET恢复ready（全main+37补测）|无必须新增业务接口的阻断；详见证据边界与非阻断脚本加强意见|
|R3|PASS_SERVER_SCOPE|ECIES解密→prefetch200→activated，错误recipient拒绝；config200、telemetry→A73/B404|无必须新增业务接口的阻断；详见证据边界与非阻断脚本加强意见|
|R4|PASS_SERVER_SCOPE|17边界/26旧BLE核心/19guards本轮通过；前轮旧12行关闭窗口恢复有HTTP证据|无必须新增业务接口的阻断；详见证据边界与非阻断脚本加强意见|
|R5|PASS_SERVER_SCOPE|206项全src/package/lock/adapter清单测试输入=11:52现役，测试后runtime_unchanged；11:58六发布文件及公网API路由JSON/鉴权/窗口核同，生产无重启|无必须新增业务接口的阻断；详见证据边界与非阻断脚本加强意见|
|R6|PASS_SERVER_SCOPE|四字段工位/九字段challenge/两字段confirm/旧claim协议清楚；不要求人工录台账|无必须新增业务接口的阻断；详见证据边界与非阻断脚本加强意见|
|R7|PASS_SERVER_SCOPE|固定验收提交c000bede已独立核远端；可复跑脚本/最终main证据/回滚指针/对外合同已落仓；Air和Studio两份MD实际字节SHA核同|无服务端验收阻断；13随后归档review/delivery索引，不改变已验脚本与业务|

## 静态关键结论

- 首次工位信任不依赖Device Bearer；受控签发不预建台账，私钥持有证明后才登记owner。设备long-term私钥和工位secret职责分离。
- 准入链：registry active与ble-key-v1/version/owner→claim签发同version凭据→真实credential校验→session准入→prefetch记activated。无需手工添加DEVICE_SN_ALLOW或per-SN config scope；config按全局/内置回落。
- Brain是confirm后的跨库幂等步骤，故障时可bound+initializing、原owner不回滚；GET回执重试ready。已有错误Brain映射显示unavailable不承诺自动修。
- 遥测另有TELEMETRY_SN_ALLOWLIST门，11:52现役名单与注入开关为空；私有补测验证非空不含目标会403，因此不只靠active推断上传。
- A/B列表以parent_account_id过滤，dashboard以public_id查当前owner；本轮合成亮度73写库→A73/B404通过。
- 无APK版本字段门控；严格白名单不允许安卓另加version字段。与未来OTA覆盖风险无关，不修改OTA。

## 本轮独立实测

verification-37为私有副本；Node24.19.0、全新临时DB/随机secret、环境清理，不读生产凭据。selected-router补测exit0：真实/sms/verify新建A/B及服务端JWT（合成验证码、未发短信），Brain账号插入故障/GET恢复，config200，telemetry显式门控、真实SQLite记录→dashboard值/A-B拒绝、错误recipient解密失败及既有完整链。

17边界、19guards通过。旧BLE核心首次因私有快照漏复制被测试import的register-device-identity.ts而未运行成功；补复制原字节后26/26通过，两个日志均留存，未改产品。

旧HTTP脚本不是main；新增37补测也不冒充main。原两连接边界是顺序竞争，前轮37另有5轮双进程证据，不能互换描述。全局4096容量仅源码核，不实压。生产正向真实C/运营商短信/iPhone/USB物理确认均未进行，不混入服务器隔离验收通过范围。

源码和配置输入：前轮60485d45三新模块/两挂载/adapter；本轮11:52 preflight提供现役全src SHA与Node22.22.2。37候选快照中相关准入链文件与现役hash相同，其他Ark/倾听/搜索文件的差异完整列于snapshot-live-comparison-37.json，不能把候选整树当现役部署。

署名：codex（OpenAI）| 2026-11-05

## 完整main与当前部署最终核验

已全文审13新增190行device-enrollment-main.test.ts与远端启动脚本；嵌入执行脚本与当前文件SHA同为280585597a43c9ed47f2c707d420e7ad617d59a5fdeeea23954191e47a49c401。main-attempt1.json exit0、9组断言通过。不是手工挂Hono路由：spawn真实src/index.ts，Linux独立net仅lo，env白名单，无生产.env或外部网络；独立cwd/数据库/随机密钥，生产node_modules复用同一安装。

206项源/package/lock/adapter SHA逐项与preflight完全相同，运行后runtime_unchanged=true。测试包含真实服务SMS verify登录（合成码）、工位子进程重复签发、PoP、Brain故障恢复、claim解密与prefetch、默认配置、真实SQLite遥测及A/B、服务重启、关闸超期旧12行恢复、owner/version撤销。

11:58 online-final六发布文件与测试manifest一致，mtime早于当前主服务启动；主PID4186397/restarts51保持。API/V1公网路径返回真实JSON预期拒绝，Nginx转发3001；公网/health实际是SPA HTML，不作为后台health成功。原C仍无台账/声明17台总数，不能据此称C真机已验。现役telemetry名单/override为空，窗口与0600保持。

13远端17边界/19guards/新旧HTTP通过；core首轮缺测试CLI依赖保留失败，regression-core-fixed复跑26/26。37本地相同漏复制已纠正，非业务修复。

main脚本有三条非产品阻断的加强建议：逐字段断言14行/算法；重启后直接原credential鉴权、恢复后新receipt activated；修正single-use parent tokens措辞（实际一次性的是验证码）。完整源与密码学合同已独立检查，不把这些建议升级为改造架构要求。

R1–R6的通过指服务端代码、隔离运行、部署对应和固定HTTP/工位合同；不等于运营商送达、iPhone TLS、USB写入、本机物理确认、C真实上传。R7仍需13提供新脚本/文档固定提交与推送、回滚指针、Air交付。

## 12:03 最终脚本与交付文档补审

最终88d5c90b脚本与远端执行嵌入原字节相同；main-final.json在12:02:26 CST exit0、9组PASS、206项manifest匹配、runtime_unchanged。三条原建议全部落实：逐字段14行/摘要/算法、重启原credential prefetch、旧12行恢复后的新回执activated、一次性验证码措辞。R1–R6服务端结论保持通过。

对外SERVER_ACCEPTANCE文档已全文核读：四/九/二字段、两类材料职责、claim短TTL、Brain后置幂等、旧12行恢复、C未验/合成隔离边界均正确。一次性回传两项收尾：新TTL精确等差断言因源码两次取时可能119999而偶发假失败，建议仅调整工装；仓内归档和文档远端目录仍为首试，须随最终结果统一替换。二者不是业务缺陷，不要求生产重启或新增测试面。

37未改13文件。R7仍等固定commit/push与Air索引。

## R7最终关闭（2026-11-05 12:08 CST）

独立git ls-remote核原分支codex/p003-auto-enrollment-20261104已指向c000bede775600ae4d43ebc8efc4bafe6fd52d2f；提交仅含测试脚本和文档/证据，没有业务源码变更。

最终脚本SHA92b41f893b16daa13f360c3afeb53433e43966dc6218ae50ad80e7693b06fe43，与提交blob、工作文件和远端嵌入执行字节相同。TTL工装改为119000≤DB时距≤120000，响应120与14行DB到期相等保持。main-final.json对应120340隔离目录，12:03:44 CST exit0/9组PASS，206输入清单与现役采集相同，runtime_unchanged=true。旧88d5版保留为历史，不冒充最终版。

仓内SERVER_ACCEPTANCE.json的main/manifest及main-test.stdout均与最终结果相同，证据索引全部SHA核过；最终main JSON SHA f47031cfe6d36b73d1707184aa34c74a905bfe49939dd51ecd76bece2877dee7。兼容声明已限定协议侧，正文远端目录同步120340，一次性验证码措辞已改。DEPLOY_ROLLBACK及基线tag7ccd1f7c存在，逐文件漂移拒绝/不整库回灌/不覆盖v384边界保持。

12:06:41 CST通过严格已知主机键SSH实际回读Air文件，身份Rayman.Chen/LocalHostName一致，两份SHA/bytes与DELIVERY-13、提交blob、Studio Downloads全部相同：

- 主回执P003_MINI002_AUTO_ENROLLMENT_SERVER_ACCEPTANCE_20261105.md：14229字节，d0105b2b3b03f0aa16655b9df8c30c5fa0d114d14437676cfffa6a751fda61b5。
- 完整合同P003_AUTO_ENROLLMENT_CLIENT_CONTRACT_20261104.md：16611字节，8b0cedb3716da072f67b8b0cf0719594798ed01b414ee26ff65f50062aa4a1e2。

R7关闭，前文“待提交/分发”和旧脚本SHA均为阶段历史，由此最终节取代。13随后仅归档本review与delivery索引，不是新增业务发布条件。37原树HEAD6c2cc932/既有dirty34项未变，未重跑测试、未改其他树或生产。

署名：codex（OpenAI）| 2026-11-05 12:08 CST
