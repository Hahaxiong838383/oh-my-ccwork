# 39：v384三条退出RTC定向验收通过（范围限定）

固定运行候选 `5b3fdaac2b0e6d552a899ea7a941616cfbed2d5d`；测试特性binary SHA `270df2ab4944d0a4f7ff66a7a8f36a9c5ab6f418885d2edf921126f6c807a010`，90构建输入逐一对Git核同。正式无feature产物属于13，39未部署。

| 真实ASR退出文本 | trace | 客户端结果 |
|---|---|---|
|恢复聊天|p0-39-42d85df8-acc3-4504-ab7a-1c17f4ce1aef|原请求exit completed→同房新聊天音频/字幕/metrics，通过|
|结束倾听恢复聊天|p0-39-b4ac56be-5ce0-4cad-a241-17f1c98054bb|原请求exit completed→同房新聊天音频/字幕/metrics，通过|
|小可结束倾听|p0-39-166fa4fa-31db-48ca-80b5-69c7d62ca01f|原请求exit completed→同房新聊天音频/字幕/metrics，通过|

三例都完成：真实STT final与原始Worker日志核对、可信agent proposal(session/participant/epoch/TTL)、Android替身唯一seq发送exit、同request_id/seq completed(normal)、消费者exit_completed、无断房重连、退出至新输入之间无音频、同房新chat正向音频/字幕/metrics、最后API查无房。独立只读audit_rtc_exit.py逐例通过。

短证据索引：
- `evidence-39/rtc-exit-audit.json`：三例result/Worker日志路径、SHA、精确final、独立审计。
- case0原件：`evidence-39/rtc-attempt4/case-0-result.json` + 同目录worker.log。
- case1原件：`evidence-39/rtc-case1/case-1-result.json` + 同目录worker.log。
- case2原件：`evidence-39/rtc-run/case-2-result.json` + 同目录worker.log。
- `evidence-39/rtc-cleanup.json`：7个本轮房间含失败尝试均不存在；自有最终Worker与Brain已停止。此前一个未分配Worker的失败房由probe兜底删除并判失败，未伪报自动清理通过。
- `evidence-39/brain-input-check.json`：bundle/manifest/65冻结Git输入/两资产/三合同独立核同。

必须保留的边界：
1. 前置使用合法Android控制enter→received→local_ready→completed，再上传故事和真实exit.wav。没有伪造STT、proposal或ACK；不是语音进入通过。
2. 首次Ready因软件probe先收到包、后绑定agent属性而失败；只在私有probe调整为先通过原trusted(kind/name/SID)校验再发布麦克风，不接受不可信包。随后两次旧进入夹具被真实ASR识别为“小”/“逍客”，完整保留 `rtc-attempt1/2/3`，语音进入ASR问题不能抹去。
3. 第四轮case0成功，case1受隔离非canary agent30秒容量发布周期影响未分配，失败保留；随后按原harness每例独立Worker运行，case1/2通过。未放宽产品超时或改产品生命周期。
4. Brain正文为确定性替身；Android为v380软件消费模型，不是v384 APK/真机；EOT未接真实模型而降级。此证据不能验证H1 Ark知识修复、真人唱歌或整体倾听体验。
5. FeedbackReserved/FeedbackActive由13提交3636e015仅cfg(test)新增用例覆盖；39核diff仅测试、非测试前缀逐字相同，并读到`39-v384-feedback-exit-final.log`该用例1 passed。不是本轮RTC反馈中退出通过。

生产保护：普通/search两池PID、binary、env/window/release指纹前后完全一致；listening池仅PID和canary.env出现13已提前告知的同身份JWT续期重启变化，二进制仍旧27a72325…、其它核查项未变。39未改生产。

建议13可将三条短退出候选提交发布验收，结论保持上述范围。正式部署后仍需v384真机：同房进入倾听→三条短退出任一→原房继续聊天；语音进入识别与真人体验另记待验。

署名：codex（OpenAI）| 2026-11-04 18:14 CST
