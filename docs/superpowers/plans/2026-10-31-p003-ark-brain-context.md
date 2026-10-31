# 方舟状态与小可大脑实施计划

> 执行方式：Codex在专用工作树内亲自实现，依次执行并持续自检；辅助代理仅作只读评审，不代写业务代码。用户已明确要求并行执行，不重复等待开工许可。

**Goal:** 让小可按可信设备身份解释世界观、历史玩家状态及新鲜端侧奖励进度。
**Architecture:** 保留Analytics夜批及现有Rust Worker；新增有限历史事实读取、轻量设备状态接收和Brain按需事实注入。
**Tech Stack:** 现有TypeScript/Hono、node:sqlite、zod，无新增框架。
**Spec:** 2-Projects/P003GameDemo20260513/docs/ark-brain-20261031/DESIGN.md

## 全局约束

基线0708d768固化普通Brain现役15文件差分；新改动单独提交。默认关闭、目标02000026；不触碰其他设备和搜索/倾听/Analytics现役开关。原始对话/音频/凭据不入Git。当前SN夜批0条是现场事实，不合成生产数据填空。开发会话不部署，由总调度验收后执行。

## 顺序与检查

### 0. 核验基线
- [ ] 读AGENTS、README、RUNTIME_BASELINE与设计；核分支及dirty，避免覆盖总调度刚固化的源码。
- [ ] 复用已有兼容node_modules（不盲装依赖）；跑device-brain、xiaoke-kb、相关auth/analytics基线。现役固化与候选测试有差异时如实记录并只修本功能需要项。

### 1. 冻结最小合同与静态事实
- [ ] 在项目docs/ark-brain-20261031写版本化snapshot JSON/fixtures和Android接入说明。读取现有57事件schema和当前内容目录，确认item_id映射；旧端侧9/13源码只作参考，不能写死当前奖励时间。
- [ ] 增加知识命中/实时缺失/金币歧义测试，阻止未核验夜航机制替代当前G1奖励回答。
- [ ] 运行红测，最小修复xiaoke-kb并验证正常世界观和闲聊无回退。

### 2. 历史摘要与设备身份
- [ ] 新建独立ark事实模块，Analytics内部受鉴权摘要路由及对应测试；按完整deviceKey限定、有限字段/时间窗/返回大小，必要索引做增量迁移。绝不把rollup当玩家状态。
- [ ] 红→绿覆盖：不同SN、换绑/禁用/凭据撤销、未知字段/GM/truncated、乱序补传、绝对after=0和unknown、原始数据已过期、库异常fail-closed。不得用registry.updated_at当绑定epoch；无归属证据的旧数据unknown，GM日与未知GM来源不进入真人状态。
- [ ] 保持Analytics写入/结算协议不变，检查已有摄入/查询回归。

### 3. 轻量实时快照
- [ ] 新建有界schema、持久当前状态store和Device Bearer路由，优先按设计独立POST /v1/device/ark/state。身份从sub，限频/大小/门控有负测；状态为未知可正常返回，不伪造0。
- [ ] 红→绿覆盖重放/同ID冲突/乱序/旧boot/跨日/未来钟/过期/换绑/暂停/可领取/当天完成；只对当前快照重试幂等且不续期，覆盖后的旧seq统一stale。无新鲜快照不得生成倒计时数字。

### 4. Brain及管理员验收入口
- [ ] custom-llm只对正常、受信设备且命中方舟状态问题按预算读取；静态用途不额外查询，闲聊/天气零额外等待。信息注入与管理员预览复用同一函数，展示来源/截至时间/未知原因。
- [ ] 需要界面时在现有Worker Brain顶部tab体系内加最小“方舟数据”预览/门控，不再挤到长页面；门控默认关闭，不能仅保存draft却声称运行生效。若首版只做验收API，在回执列明UI未做，不把API充UI。
- [ ] 用隔离HTTP/SSE拦截上游确认prompt中的主体、数值、时效和无数据降级；不消费真实儿童对话去跑外部模型，不写测试事件到生产。验证动态状态问答不会经persistTurn→extractAndPersist写入profile.game_progress/memory-item；保留审计对话、正常画像抽取不回退。

### 5. 交付与复核
- [ ] 必要完整类型检查与相关回归；复查普通聊天无额外查询、搜索/倾听未漂移。新鲜上下文只读评审，修复实质问题后复测。
- [ ] 产出SERVER_RECEIPT.md、ANDROID_HANDOFF.md、ROLLBACK.md、TEST_RESULTS.json、MEMORY.md；清楚区分服务端完成与安卓/真机待联调。
- [ ] 精确add/commit/push当前专用分支并ls-remote验证；不合main，不覆盖其他工作树，不部署。向总调度报告代码锚、真实通过项、未完成项与最短下一步。
