# 主13对Grok421的核验与取舍

已完整读报告/JSON，35份混合原件此前已独立hash核同。按其合成实验，316行场景索引v2冷连接页miss为30，v1为25；2000行超过513时才明显少读。页计数使用SQLite3.54.1，Node精确语义检查为3.53.3；冷连接miss不等于实际冷磁盘IO。当前不增加该索引，也不添加历史worker连接，避免没有针对性收益的改动。

报告再次没找到的708 Linux证据实际在ZERO-LINUX-RESULT.json，包含完整stdout：250ms持锁->503/62.101762ms/6次；45ms持锁->200/51.343143ms/4次，原日志SHA4e92ce4fed0404575886b3c591cc4690c72c7c9c4e04d6354d06c27aa57ccb0e。其引用bounded-linux-physical-busy-v2.log属于167旧方案，不能用旧结果否定708后证据。本机4次失败原记录在ark-zero-busy-physical-macos.log与-v2.log，6次改进在-v3.log，原文都保留。不是“4次失败、6次通过”这样的测试通过数量，而是两种重试次数上限。

其拓扑描述略有误：9c5154e7的Ark POST服务在Brain child，设备生产者在独立worker线程，非同一child事件循环；两者同cgroup。已用阻塞Analytics主线程600ms时真实请求仍完成的测试覆盖，Linux定向证据也通过。

下一步以修正后的同候选、同Node24和相同资源上限做云/NAS环境对照。NAS现有Python3.11.2/SQLite3.40.1、cgroup1与云不同，不能冒称纯磁盘单变量或生产验收。不买资源、不迁移生产、不放宽门。

署名：codex（OpenAI）｜2026-11-18
