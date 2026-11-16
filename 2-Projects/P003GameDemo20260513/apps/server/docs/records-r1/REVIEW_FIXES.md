# 独立评审与一次修复
C SN BJP00326081002000031。未部署，未生产验收。

独立Codex评审固定范围9d8dd399b22f5a66f54ef268c05217972fec59e6至0af91808c3d909ecebb18d72033ef1a98275cafe，git archive Node24独立27/27通过。评审不是主13/Grok最终验收。

1. Important：pending引用SELECT r.*使1,000条×32物品重复复制body。独立复现1,288.6ms、RSS+272.6MiB、heap+206.8MiB，低于10k/32MiB默认上限。改为SQLite查询首个不兼容引用，不读取body。新增压力回归RED→GREEN，最终全套运行120.1ms，heap+256,496字节，RSS无增长；仅本机样本，不承诺生产延迟。
2. Important：bogus UUID或epoch=0先触发403整批隔离。新增真实HTTP负例RED→GREEN，origin预检复用UUID/正安全整数schema；坏记录invalid_record，合法同批正常ACK。
3. 合同缺口：父分页外层401缺no-store。因合同要求所有新响应no-store，按必要修复处理；真实HTTP RED→GREEN。

修复后R1 31组、mini008 16、Ark state16/history11/answer7/daily-context1/natural-history10及Telemetry脚本（内部37项）同次运行：Node test runner 93/93。未再派第二轮代理评审；一次修复以失败回归与全套GREEN验证，最终交主13/Grok固定候选复核。

Final: fixed pending reference fanout — bounded memory/lock time RED→GREEN。
Final: fixed malformed origin batch isolation — per-ID rejection RED→GREEN。
Final: fixed 401 cache header — no-store RED→GREEN。
Final: minor (deferred): 无。

Final: Ruling: 评审未判断生产部署与磁盘实况，由本任务只读审计补足共享盘数字，仍不据本地测试批准发布；代价为需主13上线前重核。
Final: Ruling: 安卓durable outbox/真机/手机与产品摘要决策属三端未验边界，保持policy_pending及禁止生产上传；代价为用户页面新摘要仍不可用。
Final: Ruling: 旧Telemetry跨代际、语音路由与基线类型错误不在此补齐；已实测并记录，不扩到ASR；代价为整树全绿和旧usage历史隔离仍未达成。

署名：codex(OpenAI) | 2026-11-16
