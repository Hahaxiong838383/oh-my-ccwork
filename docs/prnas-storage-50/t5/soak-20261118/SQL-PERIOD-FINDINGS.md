# T5 查询等待分离实验

结论：未证明缩短CPU周期能解决完整混合超时，不采用该配置作为修复。原.5CPU/768MiB/120ms/125ms/P99门未变，生产业务无变化。

Grok413独立固定193的Mac 10000事件/400查询通过，仅属smoke；不抵消Linux300k的29/250历史超时。Grok414核同其中27条失效周期：26条在客户端abort之后才进入接收handler，首handler墙钟2545.86ms；资产correct来自独立快照，不能代表历史正文到账。

固定9e9b4819测试诊断器对原失败合成库的拷贝运行，真实HTTP+ArkRuntime保持。同步SQL最大样本墙钟82ms/线程CPU13ms，说明等待占主导，但不能据此区分IO、锁、调度。全混合memory.max事件累计8530次，copy-only没有触及memory.max；相关性尚非根因。

| Run | CPU周期 | 查询数 | transport失败 | 全组P99 ms | 最大 ms |
|---|---:|---:|---:|---:|---:|
| 01 |100ms|200|0|68.792|146.247|
| 02 |100ms|750|1|46.382|135.482|
| 03 |10ms|200|0|102.801|112.064|
| 04 |100ms|200|0|67.981|93.608|
| 05 |10ms|200|0|80.859|81.191|
| 06 |100ms|200|0|93.248|98.323|

01只复用已有统计缓存；02起对拷贝source.mutation递增，强制实际重建。02一个维度触30s预算，后续暖缓存各9秒左右；不得把暖缓存改进都归于CPU周期。顺序试验没有完整消除缓存、IO温度的混杂。[systemd说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html#CPUQuotaPeriodSec=)确认周期含义；运行cpu.max实际核到5000/10000及50000/100000，CPU总额度均.5核。

初始comparison driver在03完成后，因为自身Python SQLite连接未close，被fuser阻止继续；随后显式close，V2接续04–06，原失败日志保留。这是诊断脚本问题，不是产品回归。

137个证据文件已经归档、两端SHA和逐文件hash核同。为给下一轮腾空间，只删除可复现派生拷贝的两个DB，原始失败DB已重新SHA核同并保留，全部诊断日志保留。

下一步：固定9e9b4819、原完整300k混合+SQL profile+CPU/内存/进程取证；不增加额度、不放宽门、不部署。24h仍NOT_STARTED。

署名：codex（OpenAI）｜2026-11-18
