# 判读规则：v2 的精简执行合同

本规则用于已采集快照判读，不授权任何修复/网络调用。报告必须“人话影响→动作→技术对应”。

## 数据与严重性

- schemaVersion必须2，checkedAt须为该次采集窗口，reportError/缺字段/旧报告=巡检未完成；有新鲜完整critical报告时非零退出仍可判读。
- info不影响探针status。原始WARNING可只是已知测试差异，不能改写成探针OK，也不要称warning为故障。只有critical需要优先处理；信息项也可能待人工确认。
- 同版本control_release_drift且state=drifted：原始warning，判读critical，明确差异。版本落后且sourceCommit有证据已过时才判断待补签，仅给H_CONTROL_SOURCE_COMMIT=<源提交> ops/attest-current-h-control-release.sh check，不执行、不猜提交。
- 新旧分开：有ageH/lastErrorAt/downSince必先报年龄，>=24h标旧账，未知写未知。lastReportAt不是首见时间。旧critical不消失，只是不冒充新事故。

## 逐项

- egress_down：平台侧受测模型出口阻断，写自downSince起已X小时，下一步平台运维核对dev198 xray实际[in-main -> tag]与balancer探活，别动bridge。egress_gate_off/egress_probe_missing是info；egressOk空=出口未确认。飞书连接正常不能证明模型通，单出口探针也不能证明所有模型业务请求成功。
- app_errors：quota_window/auth是租户侧warning；其他类别<24h critical、>=24h warning，未知年龄保留探针级别。报details真实botName/uid、类别、年龄，不凭uid形态/名字联想。
- rpc_orphaned：新孤儿critical，读fresh明细的身份和任务前缀/年龄；建议人工看timeout/重启记录，在控制面恢复页决定，不手改durable。
- rpc_orphaned_stale：旧账warning，每10分钟自动回收；连续两天仍在才查expiry.lastSweepAt与rpc orphan sweep，不猜已连续两天。
- orphan_recovery_pending：info。total-live是非运行候选；liveUnknown另列，确认未运行=total-live-liveUnknown。live缺失/null不当0。全live正常在跑，不能重跑。lastReportAt滞后可能是页面重跑占住上报，不直接认卡死。
- tenant_parity_lag：warning。逐条区分frozen跟随失效/shell同名空壳/附件缺失/托管块缺口，不批量覆盖。精确已知例外：uid=u-001422f6e5、陈川测试bot、agent-method是有意测试空壳，保留、不追平；不扩散到相近名或其他skill。
- tenant_parity_notes：合法L2个性化info。L0公司共用、L1部门与L2个人允许增量分叉；Skills差异不等于飞书权限。仅附件缺失建议增量补附件，个性正文不覆盖。
- worker_restart_pending：info，等夜间03:30正常生效，不建议立即重启。
- grok_refresh_failed：warning，和egress_down同时出现按同出口根因合并但保留两code；单独出现根因未知。
- 其余服务/定时器/outbox/contract/durable/disk/journal/token sweep/tunnel照探针级别，不自行改阈值。未知code/结构必须明示并建议人工核实，不能静默忽略。

## 身份、范围、记忆

- 身份只认details.botName（parity用bot）/uid/taskId前缀；缺失写探针未给身份。dev198巡检不覆盖Mini，别因为没发现就说Mini缺失。
- 历史对象：智能助手_产品专家在dev198、AI专家在Mini对照测试；实时placement未提供就不声称本轮验证了站点。
- memory中的四源hash由脚本当日重新计算，excerpt标行号、修改时间、截断状态；它是定向摘录而非全文。源变更会触发模型，源缺失/冲突不从旧B镜像补猜；报告自身事实优先当日采集，规则事实参考最新A纠正。
- 09-11比较基线：控制面v1.67.0/in_sync/mismatch0，releaseId=20260911-170637-h-control-v1.67.0；Bot18/18、记忆17/17、已知测试1、个性化4人6项。这不是永恒数量阈值，合法扩容/升级不当事故。
- 四键：project_feishu_grok_h_byos（平台）、feedback_tenant_capability_drift_mechanism（租户差异）、feedback_identifier_shape_is_not_identity（身份）、feedback_concurrent_sessions_shared_checkout（并发保护）。只读报告不需要共享工作区写入操作。

## 排版与安全

第一句先人话，不以WARNING/CRITICAL/code开头。需要关注只放真实人工动作，已知测试与个性化进入概况。计数在末尾一次，不能把warning称作info。连接和出口分开写，未知单列；长hash/路径/命令不塞表格。仅必要时展开releaseId/源提交/字段。禁止改文件、数据库、任务或生产服务；禁止部署/重启/补签/覆盖/重放/取消/外发。采集失败不报平台正常。
