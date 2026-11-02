# v375 独立验收矩阵（会话45）

状态：合同已核，候选未到；以下是待执行标准，不是通过记录。

客户端固定源码52b89ec9a4823eb62b424f094d613b4a09a10708；业务实现仅会话48，线上发布仅会话13。本树647285fc是旧基线，不用于服务器验收。隔离测试必须记录48完整候选SHA、归档文件SHA256、Node与依赖版本、命令、退出码和日志。

|组|实测要求|阻断判据|
|---|---|---|
|合同/配置|00/01/10 raw，11才分层；默认全关；配置完整回读、单设备；request_id位于context|单开tiering宣称已聚合、字段猜测、范围扩大|
|聚合|12类固定维度；CST epoch周期；闭合桶count最终值；checkpoint为max；20次→count20；重放不累加|余额/奖励混入计数、非法维度/未闭合周期被收|
|样本|两种capture_source与源事件匹配；嵌套源字段白名单；捕获与原始时间校验；旧样本可有限回溯|自由文本透传、把请求创建时间误当捕获起点|
|授权|请求创建/生效/过期/撤销/事件范围/额度/完整设备身份；A请求不可供B使用；内部API鉴权|仅凭非空ID授权、过期新样本仍accepted|
|精确ACK|raw+aggregate+sample+invalid混批；每ID唯一终态；RID原样；未知ID不出现|整批400导致合法raw进入客户端死信；ACK早于持久化|
|幂等|同批/跨批/重启/跨请求重复；相同ID不同内容冲突；配额不重复消耗|重复count/重新accepted/同ID覆盖原内容|
|压缩|同JSON raw/gzip入库同义；wire/inflated界；CRC/截断/垃圾/双encoding/膨胀；413为JSON|同步解压阻塞、越界写库、HTML413|
|并发|2慢body占位；第3次背压；健康请求可回；失败/超时释放槽；writer单提交|无限队列、槽泄漏、健康访问被阻塞|
|TTL|按received时间有界删除；raw/aggregate/sample分别统计；样本payload删除后seen与额度仍在|删payload连带丢去重；谎称Launcher14天是绝对重试上限|
|关键事实|奖励、钱包、库存、逻辑日、恢复、失败、未处理交互仍raw|失败/资产只留aggregate|
|Ark边界|聚合/样本不生成资产且不挤占raw扫描预算；同源样本不能重复结算；GM/epoch/快照时效保持|count被说成余额；unknown变0；旧主人数据跨epoch|
|记忆/对话|动态数值不进入长期画像；审计仍留；普通闲聊不查analytics；隔离SSE回归|动态数值污染长期记忆、普通问答回退|
|后台|现有tab配置/范围/TTL/请求状态可见且回读；API结果不冒充UI|只做API却声明界面验收|
|部署保护|manifest仅候选增量；保护现役BLE/v374/搜索/倾听/Ark grant；回滚可复核|整树覆盖P2、旧基线发布、并行改生产|

## 已确认的客户端边界

详见CONTRACT-45.md。Launcher inflight不受14天/容量清理；Godot raw无年龄TTL。默认不清理幂等墓碑，在明确最大接收年龄与端侧重试上限之前，不得宣称有限seen TTL足够。样本进入Launcher后不再按Godot3天清理，服务端必须自己校时效和请求状态。

## 工具和证据规则

- `prepare_candidate.py` 只接受48回执顶层 `candidate_sha` 精确匹配的完整SHA，baseline或嵌套字段不能替代；git archive到私有目录；从候选运行，绝不覆盖48工作树。
- `audit45-http.ts` 是独立真实localhost HTTP+writer+SQLite兼容/压缩/重启检查；复制到隔离候选apps/server/scripts后运行。使用合成主体，绝不使用真实SN/儿童正文/外部模型。
- 继续执行候选自带Ark/history/state/runtime/http-sse等回归，但报告注明这些是复跑已有测试；不充当独立新事件测试。
- 候选新接口稳定后补其授权/TTL/计数独立用例；候选未到、API适配未完必须写NOT_RUN，不能因已有测试全绿给总PASS。
- 本机延迟只作为本机证据；HK真实负载、v375当前PCK实际分层能力、7天真实统计、真人语音均单列未验。
- 仅文档提交变化且运行源码、配置、迁移、依赖锁及测试字节完全相同时，记录逐文件hash等价与原证据SHA，不机械全套重跑；业务变更、失败或未解决疑点按影响复验。原来未验的项目仍保持未验。

署名：codex（OpenAI）| 2026-11-02
