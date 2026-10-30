# P003 倾听下一批开发安排 · 2026-10-30

用户授权：部署已完成的后台管理能力，并让“P003 倾听 Brain｜开发接续”“P003 倾听 Worker｜开发接续”分别继续开发测试。继续使用现有会话38/folder28、39/folder29，不再复制历史或新建同名会话。原历史快照停在首批基础模块；当前代码和本文优先于旧对话状态。

## 当前接续（主会话验收后）

Brain A/B已交付`39187a60`，主会话复核52/45/38/12及tsc通过；Worker `9007bfd8`已有完整Linux508项＋双方真实HTTP隔离对撞1项（合成身份/模型），不是完全未互通。当前只修正可联调候选：38合入`2d998cc3`标签代码、定向浏览器回归、统一进度并复用39现有joint入口；39修复pipeline暂停退出后job未收房P1。以各树commit/manifest/回执直接对齐，R26留给会话24，不加发布/审批框架或重复广泛测试。

09:50:48为管理后端，10:17:32为用户已验收的静态标签页（`b508f9b2…`）；新运行链路未部署。当前恢复点及最小重跑入口见Brain项目`docs/listening-20261030/NEXT_BATCH_RECEIPT.md`、`DEVELOPMENT_NEXT.md`。真实Android/RTC、普通聊天体验和回滚仍按证据逐步补；本轮不部署、不扩设备、不改搜索窗口、不重启线上服务。

## 已发布边界

主Brain管理配置于09:50:48 CST上线，业务22505d8b、发布源beafc980。真实倾听尚未接入，enabled=false、allowlist=[]、ready=false。回执：Brain工作树`2-Projects/P003GameDemo20260513/docs/listening-20261030/ADMIN_RELEASE_20261030.md`。后续开发不得直接修改生产或为测试打开线上总闸。

## 顺序与职责

| 批次 | Brain会话38 | Worker会话39 | 出口 |
|---|---|---|---|
| A：授权与接口 | 权威会话登记、严格内部鉴权、设备签grant、15秒租约；优先冻结真实HTTP合同和可执行fixtures | control实际participant/trace绑定、VAD、完整输出出口盘点和本地fake adapter测试 | 合同与权限矩阵通过，普通签票45回归 |
| B：音频与独立内容 | 独立summary/feedback，隔离普通chat副作用、消费配置快照 | 按已冻结合同接异步lease/summary/feedback客户端；逐帧许可、取消排空、一次反馈回倾听 | 真实HTTP联合模拟＋Linux完整Cargo |
| C：合并验收 | 运行状态来自可信能力和应用确认；与Worker联合检查 | 普通R18与搜索候选R26分别适配/验证，保留搜索显式播放标记 | 当前Android协议确认、真人和回滚测试后另行发布 |

Brain可先发布合同再继续自身实现，Worker的独立control/audio工作可并行；依赖真实HTTP字段的实现必须以冻结合同为准，不各自发明协议。

合同唯一写者是Brain：`4-Assets/contracts/p003-listening-http-v1.json`，配套`4-Assets/contracts/p003-listening-http-v1.fixtures.json`。明确version/status、角色、头部、绑定字段、错误码、lease TTL/刷新、policy revision/场景/tuning快照、过期/撤权/幂等、summary CAS、反馈字数/时限。充分验证后标`status=frozen_for_integration`。Worker只读Brain文件、复制同字节版本并记录commit/SHA，不修改Brain树。既有`p003-listening-mode-v1.json`是Android/control合同，不得私自破坏。

## Brain具体要求

1. 在`codex/p003-listening-brain-20261030`亲自实现，不交Cursor。复用已发布settings/store/CAS和管理接口，不能重建第二套设置。
2. 权威会话登记必须可验证当前SN/account/session/room/trace/source/expiry/设备能力/目标Worker就绪；日志表不是权限源。签grant与租约都复查registry状态及归属；缺secret、错误角色/账号、改绑、过期、搜索窗口到期均拒绝。严格worker JWT＋service Bearer＋grant，不用匿名/开发secret降级。
3. 主权威租约15秒、5秒刷新、请求预算1秒；关闸/移出名单/禁用场景可撤权。策略版本等于config.revision，不是schema_version。所有tuning是真正被消费的快照。
4. 独立summary/feedback不得调用普通chat并污染消费吐槽armed、风格/首聊状态、长期画像、对话持久化或工具；故事/歌词不自动记永久画像。不为未接线功能强行把runtime.ready改true。
5. 测试授权矩阵、过期/换绑/撤权、CAS、内容上限/摘要修订、真实路由无副作用，以及原签票/配置/filler/普通路径回归。真实模型测试如需凭据按现有规则使用且不输出；未能取证项留待验，不伪报通过。

## Worker具体要求

1. 在`codex/p003-listening-worker-20261030`亲自实现；普通基点53727c3f/R18＋style-ark。先读Brain最新文档和协议，不整树cherry-pick Brain或搜索R26。
2. 实际participant与签名metadata绑定；持久倾听状态独立于VAD；进入取消spec/warm/paused/deferred及在途capture，排空加Android local_ready双确认后才completed。
3. 普通叙述不触发普通LLM/投机/filler/硬件/搜索；所有音频出口按purpose、epoch、turn逐帧许可。SpeechStart立即撤销本次反馈许可；SpeechEnd不能恢复旧反馈。
4. 搜索结果requires_explicit_play跨退出保留；旧epoch恢复不得回灌。当前普通树没有的候选恢复点应明确列出候选差分待适配，不冒称已覆盖。
5. 租约网络不阻塞音频循环；超时/失效进入paused而非自动chat。summary有界/CAS，反馈一次结束回倾听。读取所有后台tuning并以变化测试证明，不重复写死默认值。
6. 按Brain冻结合同实现网络客户端，保留可执行协议对撞测试。跑完整Linux Cargo和可用RTC模拟，保留旧模式/关闭模式回归；本机rustc1.70纯模块测试不能替代edition2024完整编译。构建机先查设备网络真值，只操作隔离目录，不重启业务服务。

## 共同交付纪律

- 代码/测试/文档/回滚点落各自分支，允许commit+push既有origin，精确add路径，不操作共享main或另一开发树；不改生产、Android包、搜索名单窗口、Analytics和个人语音。
- 两个会话均核实实际执行模型gpt-6.1-sol后启动；模型信息以ACP当前执行配置为准，不能只读历史metadata。各会话亲写代码，辅助代理仅可只读审查。
- 出口报告必须列commit、测试实际数量、通过/未完成、接口合同版本和SHA、回滚方式、下一依赖。同步本树`NEXT_BATCH_RECEIPT.md`，不要长时间只给计划不实施。
- 完整功能发布门槛仍为原计划：≥60固定用例、3×10分钟故事、3首歌、30分钟session、普通聊天≥20有效对（中位实质首声增量≤100ms/P90≤300ms）、新→旧→新回滚、当前APK能力与真人实听。当前均不可因后台上线被自动勾为通过。

署名：codex（OpenAI）| 2026-10-30
