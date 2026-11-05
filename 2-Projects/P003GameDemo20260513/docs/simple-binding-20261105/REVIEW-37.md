# 简化绑定最终候选独立评审

**结论：`c412d67f44b5b1384df3cc33da47ace8ed7d03cd` 的发布前实现审核通过，无剩余实现阻断。** 原CAS-37-01已复验关闭；V3合同有两处非阻断文字勘误已回13。本结论不代表已部署、真实短信送达或C真机通过。

## 已验证的结果

| 项目 | 结果与证据 |
|---|---|
| 37独立固定归档测试 | **17/17通过，exit0**。仅从c412 git对象导出，不读取未提交实现；真实SMS verify路由、Hono业务路由、私有SQLite、随机测试凭据。 |
| 原CAS-37-01 | **关闭**。同一库两个已ready独立Node进程，三轮竞争均200/409，赢家owner唯一、同账号重试成功。250ms有界busy等待修复BEGIN IMMEDIATE冲突；没有通过放宽断言规避错误。 |
| 账号/数据归属 | 未知SN自动建档；body手机号/账号不能替人绑定；A幂等/B409；disabled、删除墓碑、仅撤销历史不复活；Brain真实SQLite失败保owner并可重试。 |
| 领证/激活/代际 | 首次与恢复claim均核当前owner；新发旧owner/version凭据拒绝；旧/其他会话凭据不能激活当前会话；当前claim凭据实际prefetch才activated。 |
| 候选2新增代际处理 | confirm后version变化：status/首次claim/同nonce confirm均拒绝；新nonce恢复；原legacy未绑定version0→首次claim绑定version1→认证激活通过。 |
| 旧BLE独立复跑 | c412归档中core **26**、guards **19**、HTTP链均通过；三份测试和依赖CLI与原37字节核同。现有legacy无版本凭据兼容仍保留，不把它描述成具有新version凭据的全部属性。 |
| 13最终main证据 | `main-final3.json`：7脚本exit0；完整src/index.ts的5组/35请求覆盖SMS登录→自动绑定→ECIES领证→实际鉴权→遥测/A-B隔离→重启原凭据→归属变化拒绝。37独立审查输入与结果，未冒称独立重跑main。 |

## 最终输入核对

- 13远端隔离目录：`/opt/p003/_acceptance/simple-binding-20261105-155258`；Linux独立网络命名空间，Node22，完整main5组通过；生产运行源保持未变的检查结果为true。
- main清单203个src条目：**6个发布文件全部与c412核同；其余197个与生产preflight核同**。其中线上custom-llm/Ark文件与Git树不同，是保留线上现役内容；六个历史.bak也来自原线上目录，均没有被当作新增部署文件。
- run-main.py内嵌14份输入（业务及测试/工具）逐份与c412 Git对象核同；没有把15:47旧main-final混作最终证据。最终证据已冻结到 `verification-37/main-final3-reviewed.json`。
- 37独立测试使用Node24。三轮CAS是有限并发探针与事务源码审查，不承诺任意长时间外部持锁都能在250ms内完成；没有额外扩展故障注入。

## V3合同只读审核

主流程、团队分工、字段、nonce/临时recipient、公钥编码、pairing2领证、状态与Q1–Q7边界一致：普通新机不需要工位/声明/长期密钥登记，mini002还需适配，真实C未被伪造绑定。当前“候选验收中、以上线回执为准”的表述准确。

两项非阻断文字勘误已发13，37不改文档树：

1. §3.2“同nonce/pk重试返回同session、不延长”应限定**会话有效期内**。当前过期未claim记录可能由同nonce重建会话；端侧按文档要求过期换新nonce即可，不需要为此改业务。
2. §2补充**未登录bind-sn的401可能无X-Request-ID**，此时记录北京时间和HTTP。auth中间件先于bind请求ID中间件返回，main证据该请求RID为null；不可让端侧等一个并不存在的RID。

所读V3已在私有目录冻结并记录SHA；两项修订不阻断13准备六文件增量发布。

## 发布与未验边界

- 13负责6文件增量部署、漂移检查、备份/回滚、现役主服务及Analytics读取共享源码后的重载与上线验收；37本轮没有部署、重启或改生产。
- 已读exposure.json和13说明；本次不扩展到异源canary。该附件展示Analytics3006代理和canary本地挂载信息，不把它夸大为37独立重审全部Nginx配置。
- 完整main证据来自13；37仅独立核输入/断言/结果。真实短信投递、iPhone HTTPS、安卓/小程序页面、C设备保存凭据与真数据闭环仍待相应现场验收。
- 未重复跑全仓tsc；13记录的12项旧类型错误不改写成全仓typecheck通过。没有重测语音或改工位方案。

机器可核证据索引见REVIEW-37.json。候选2未通过记录保留REVIEW-37-candidate2.md/JSON，原设计自查保留REVIEW-37-design-audit.md。

署名：codex（OpenAI）| 2026-11-05 16:01:03 CST
