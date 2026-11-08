# 本轮运维记忆与经验

1. 本次修复目标是主池系统DNS挂起时的独立备用，不把所有历史TLS/流中停顿、安卓无声一并销号。查同一trace分段时序；公共DNS供应商归因需当时证据。
2. 正式artifact测试必须命中真实运行gate：本例任意临时agent名会绕开异步DNS；用真实rust-worker名和私有同版本SFU，不能放宽生产候选名单，不能注册临时同名worker抢正式派单。
3. 故障仅注入私有mount namespace的stub，主机resolver/其它池哈希前后核同；正常和故障两侧同SFU/语料。备用胜出必须验证connected+dns_path，不只看开关或resolver成功。
4. 日志含ANSI时先去色再解析字段。测试脚本失败保留，修正后新目录/新unit重跑；runner失败返回非零。旧版负向失败与新版通过分别表述。
5. 正式二进制来源与测试/文档HEAD分开：本次运行5453c80，测试4ef4fd6d只补cfg(test)；69文件输入核同，不能把最新HEAD自动写成线上源码。
6. 额外查询是按需200ms启动、进程并发上限2、不排队；保留TTL/TLS及10秒总预算，不做周期探测和全机DNS自动择优。当前CPU空闲和内存余量不是并发容量承诺，PSI需同时看some/cgroup，不以系统full=0证明无争用。
7. 回滚以本次发布前现役057f1972及原env为准，保ASR接管/看门狗。先核空闲/漂移，再回滚；回滚前置检查不是执行过生产回滚。
8. Air直连Worker本轮已实测可用；原中继长传多次断连后，先小块真传SHA验证，再改任务私有transport并分块续传。保持Air既有身份/严格hostkey；不复制凭据、不改全局SSH。后续实时重验网络，不把IP/可达性永久写死。

当前运行与详细证据以本目录最终回执、DEPLOYED.json和POST_VERIFICATION.json为准；历史失败不覆盖。

署名：codex（OpenAI）| 2026-11-08
