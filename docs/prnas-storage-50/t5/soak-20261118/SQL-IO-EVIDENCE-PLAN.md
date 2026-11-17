# 同步SQL阻塞与读盘取证

9e9b4819完整混合原接线复现：第5分钟50次中24次历史传输失败。首请求2495.843ms；evidence.all为1485.047ms/线程CPU6.067ms，assets.all为939.694ms/线程CPU3.138ms，schema.all仅0.287ms。SQL合计2424.74ms覆盖97.15%请求墙钟，不能再把该长段归为JSON正文等待。尚不能仅凭off-CPU区分读盘、锁、回收或调度。

新增测试专用主线程IO差分：`/proc/self/task/<pid>/io`的read_bytes/syscr；读取前后放在被计SQL墙钟之外。read_calls含observer自身proc读，不能冒充纯SQLite syscall数；read_bytes用于识别块存储读取，不把0解读为无任何等待。Linux内核proc_tid_io_accounting传whole=0，区别于进程汇总whole=1：[内核源码](https://raw.githubusercontent.com/torvalds/linux/v6.8/fs/proc/base.c)。[read_bytes定义](https://man7.org/linux/man-pages/man5/proc_pid_io.5.html)为实际存储读取字节。线程CPU只针对当前同步段；请求总threadCPU跨await仍可能包含其它请求，不据此当独占CPU。

源码只改隔离测试profile。单元检查保留结果/异常、参数不泄漏、最多64条样本；Mac IO明确null，不能冒Linux。首次Linux临时目录缺ESM package元信息导致tsx CJS编译失败，补同仓type=module后复验，原记录保留。生产src、API、预算均未改。

署名：codex（OpenAI）｜2026-11-18
