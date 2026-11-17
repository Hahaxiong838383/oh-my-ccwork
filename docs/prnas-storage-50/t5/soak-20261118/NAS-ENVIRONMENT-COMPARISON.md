# 云端与PRnas隔离环境对照准备

业务候选仍逐字节等价708a3149。f72固定552文件已Linux核SHA，修正拓扑/合成session ID的两个测试exit0。NAS使用同一云端Node24.19.0二进制/SQLite3.53.3、同一源码和依赖；Python3.11.2/SQLite3.40.1、kernel5.10/cgroup1与云Python3.12.3/SQLite3.45.1/kernel6.8/cgroup2不同。因此只比较部署环境是否承载，不将结果归因于纯磁盘单变量。

仅测试观察器新增cgroup1控制器子树读取，使用total_*包含全部子进程，保持0.5CPU/768MiB。因为v1没有v2 memory.events.oom等价累积字段，明确resource_acceptance_supported=false，任何v1样本都不能满足24h资源门；不把当前under_oom当累计OOM。纯解析测试覆盖错子树/缺计数失败及假24h永不通过；既有v2资源门/拓扑/隐私ID测试4/4通过。

尚未完成：此新候选NAS运行时兼容性和完整600s混合。未买资源、未迁移生产、未改设备窗口。回滚仅还原测试观察器；禁止回灌生产库。

署名：codex（OpenAI）｜2026-11-18
