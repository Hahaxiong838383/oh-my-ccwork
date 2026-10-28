# R22 正式性能门结算（2026-10-28）

**未通过，R22未部署至真人两台。** 原两台继续R21＋UTF-8配置修复，原期限2026-11-02 11:19不变。Agent Plan备用已独立验证可用，不代表整个R22验收通过。

| 对照场景 | 完成房间 | 有效配对 | 正文首音增量中位 | 经验P90增量 | 缺正文A/B | 结论 |
|---|---:|---:|---:|---:|---:|---|
| 普通聊天 | 60 | 29 | −0.69ms | +49.93ms | 0/0 | 该组通过 |
| 搜索中聊天 | 29 | 10 | +50.51ms | +499.54ms | 0/0 | 未达标，提前终止 |
| 续讲后立即聊天 | 29 | 14 | +149.38ms | +699.73ms | 0/0 | 未达标，提前终止 |

同一mixed房间同时测后两组，因此实际共89房间（60 normal＋29 mixed），不是118房间。mixed有14完整配对及第15对的A；所有已执行尝试保留。正常组1对、搜索组4对因提交/正文数量或实际ASR不一致不进入有效配对，不能只以WAV相同认为识别相同。

## 为什么提前停

原冻结上限每组30配对、至少20有效、中位增量≤100ms、经验P90≤300ms，无新增缺正文。前10个有效续讲配对已有5对>300ms；即使最终全30对有效，P90门最多允许3对>300ms。余下样本无论多快也不能让该组通过。09:58:53在控制器写入受控停止信号，等当前房间结束后退出，未打断正在执行的房间。

终态89房间、controller_stopped / isolated_controller_stop_requested；最终有效续讲配对中6对超300ms。**这是保留失败、停止已确定不通过的批次，不是完成原120房间，也没有追加/替换样本凑绿。** 结算器成功，发布门返回失败，未生成可发布结果。

已独立回读：隔离Worker/Brain闸关闭，jobs/remaining=0、清理健康，临时TTS故障规则不存在；真人Worker PID1175023、Brain PID2694550均未重启。以上为当时快照，后续操作重新核实。

## 已证实与待定位

- 14个真实搜索任务均answered，14个有同任务显式replay记录；合成客户端均收到有声音频。不能据此说真人听到了或内容质量全通过。
- 普通聊天29有效对未显示明显延迟回退；该结论不能推广到搜索负载或长期P95。
- 部分慢轮Brain本地前处理2–6ms、首字过滤扣留0ms；故尚无证据把该延迟归为路由规则耗时或输出过滤等待。
- Worker旧llm stream done没有room/response_id，单房间仍可能有多个投机/正式请求。不能仅靠同时间窗将它与Brain任意首字记录硬配对，也不能据此认定网络或模型为唯一根因。
- 已增加仅候选的SSE观测：headers、首body字节、首content时间，关联经过形状约束的response_id及room；不记录URL、头、凭据、提示或回复内容。不改变请求/响应协议与业务分支。Linux 461单测＋31预览回归、release/ABI通过；这是后续诊断版本，不能与已失败批次混用。
- 尚未完成剩余慢轮定位、必要修复、同版验收及真人候选部署。可转发开测回执尚未生成，旧草稿不能发作开测通知。

## 调研依据与取舍

reqwest官方建议复用Client连接池；本项目已在job内持有并clone Client，因此不把“新建连接池”直接当根因，也不先加另一层连接池。[reqwest Client](https://docs.rs/reqwest/latest/reqwest/struct.Client.html)。响应头与bytes_stream正文属于不同观测阶段，接下来按同一SSE响应关联，保留首content与首PCM区别。[reqwest Response](https://docs.rs/reqwest/latest/reqwest/struct.Response.html)。

DeepSeek说明重复长前缀的缓存可影响首token延迟，搜索附加上下文可能影响输入形态；这只是待验证假设，不是已定位的原因。[DeepSeek上下文缓存](https://api-docs.deepseek.com/news/news0802/)。沿用已验证的Hono onAbort处理，不因延迟排查撤回取消语义。[Hono Streaming](https://hono.dev/docs/helpers/streaming)。

冻结版本：Worker285ab377eed858b070947142787b8286beff02c11d9d3008daf31672a681fdeb；Brain源码c341425e及Agent Plan专用配置。脱敏逐样本与配对结果见[R22性能证据](R22_PERFORMANCE_GATE_EVIDENCE_20261028.json)。本次原始音频/正文/凭据不入Git。

署名：codex（OpenAI）| 2026-10-28 10:08（北京时间）

后续纯观测代码：Worker ebdabd7aaa373790ba8ba21720c67ef162b34169；诊断产物0e849843c170b1384833155fbc1af386fcb37ef57fab97fcc139c1400eb918c1，仅独立验证副本。已完成新→旧→新及UTF-8审计；真实主/候选进程、环境与窗口未改。
