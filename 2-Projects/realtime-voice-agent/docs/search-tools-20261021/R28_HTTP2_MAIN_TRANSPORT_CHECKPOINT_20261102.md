# R28 主链路 HTTP/2 迁移检查点

**尚未部署主服务，P2 全量尚未开启。** 2026-11-02T19:08:18+08:00。

最新固定40条对照保留在私有 `failed-paced-performance`：19精确配对，中位+0.613ms，P90+650.062ms，新版20条均有正文；A0旧基线停在TTS的TLS/WebSocket阶段，原观察窗内无正文。原20有效配对、100/300ms门未通过。不能将删失样本上界当第20个精确值，不能将runner退出0当通过。

B11的TTS连接252ms、供应商首PCM296ms；对话HTTP/1.1响应头5067ms，Brain随后模型首字706ms。慢点在响应头前，但仅凭此尚不能定为DNS。已有候选HTTP/2能力未覆盖主rust-worker：本次只允许精确主agent名加`P003_LLM_HTTP2_V1=1`显式启用，默认和未知agent维持HTTP/1.1。保留原重定向策略、连接/总超时、身份、模型、音色和ASR合同。不支持h2的端点仍经ALPN使用HTTP/1.1；不强制prior-knowledge。

同开关启用主服务的脱敏LLM阶段日志，仅含room、受限response_id、协议和耗时，不记录URL、凭据或正文。任务API、清理和其它HTTP客户端未改变。

验证：主agent准入单测在旧实现RED，新实现GREEN；Linux全套510项通过，release和ABI检查通过。新Worker产物`05a8c52848fdd93f1f308889b93ebf18b1d154ac398ac9b5848d2b43199bf14b`；preview未变`0ce9787e7eb122c240937203e63b6fafbdfe6ba4d0f2c2e2e46052e3bbac43a5`。这不等于真实接口、正式性能门或真人验收通过，仍待新产物验证。

另查出隔离配置与现役不一致：备用模型BASE_URL被置空，其余key/model仍存在，产生builder error；现役备用地址有效。旧对照两臂都被置空，不能称与现役完整配置一致。后续只在隔离环境复制现役备用配置，保留独立Brain、合成SN和数据库隔离，再重新冻结验证协议。

第一轮HTTP协议小诊断在slot0许可阶段失败，未播放测试话术：RTC信令首连超时，SDK重试后连接，音轨订阅后input帧仍为0，ASR45000081。output_ready不等于input_ready，更不等于采集/上行正常。失败完整保留；没有将其归为HTTP/2故障或补跑替换。

部署后可关闭主HTTP/2开关并在空闲时重启以退回旧模式；本次新开关和精确产物需纳入R1回滚，不能覆盖后续配置。当前没有执行生产部署或开关操作。

参考：[reqwest ClientBuilder](https://docs.rs/reqwest/0.12.28/reqwest/struct.ClientBuilder.html)、[HTTP/2 流与错误处理](https://www.rfc-editor.org/rfc/rfc9113.html#name-stream-error-handling)。连接复用减少取消后重建的机会，不保证消除全部网络长尾。

署名：codex（OpenAI）| 2026-11-02T19:08:18+08:00
