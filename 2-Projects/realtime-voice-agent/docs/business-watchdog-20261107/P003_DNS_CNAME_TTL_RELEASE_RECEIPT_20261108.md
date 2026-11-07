# P003 DNS地址提取与缓存修复：主池部署回执

已于北京时间 **2026-11-08 02:44:44** 部署，正式普通/ordered两轮验收通过，保留上线。**整体慢响应问题尚未收口**：本次修复明确的CNAME地址提取缺陷及发布前发现的TTL边界，不能将它们认定为历史4.704秒DNS等待的唯一根因。

## 修改、评审及验证

- 旧代码只取DNS ANSWER地址，会漏掉CNAME目标在ADDITIONAL里的有效A/AAAA。新版沿IN CNAME链筛选最终owner及地址族，排除无关地址。
- 第一候选虽544项通过，但CNAME与目标TTL都为1秒。主Codex新增CNAME60秒/目标1秒反例，实际发现过期地址仍被缓存；读取实际Hickory0.26.3源码证实原因。旧源码282a4167、旧正式包59e5bb26均禁止部署，未上线。
- 最终版只在采用ADDITIONAL目标地址时清除本查询与实际遍历别名链的同族缓存；普通ANSWER缓存不变。不修改供应商域名、TLS验证、DNS配置或依赖。特殊响应形态会多做DNS查询。
- Codex与Grok完成质证。Grok撤回TTL“非阻断”旧意见，接受红测，并同意新固定候选在当前版本回滚备份、空闲和新正式RTC验收条件下发布。Grok为本地源码/证据审查，没有自行SSH或重跑测试；模型4.7为其自报。
- 最终 **547 passed / 0 failed / 1 ignored**，覆盖较短/零TTL、CNAME普通答案、多跳/递归、IPv6、陷阱地址和既有取消/连接回归。Linux release/ABI通过，68个构建源文件与固定候选核同。8条既有编译警告保留。

运行源码：`ca5f95b4243cfddeaa3370e8e7ad85e7600e541d`。二进制SHA256：`fc3f84e461e5f55f4b0fed09720ee19f8fd7e668d6a5ae80431a39c0f262433d`。

## 正式部署后的真实RTC验收

使用固定自制语料、合成设备身份，实际派单至新主Worker；不是Android真机验收。两轮进程退出码均0、遗留FFI订阅0，完整输入60699样本，无测试主动删房。

| 指标 | 普通RTC | ordered超时转普通RTC |
| --- | --- | --- |
| ready | 743ms | 668ms |
| 用户final / 回答final | 2 / 2 | 2 / 2 |
| 探针收到非静音音频 | 8450ms | 8290ms |
| 实收metrics | eou/eou/tts/tts/llm | eou/eou/tts/llm/tts |
| TTS句子首PCM | 255、295ms | 268、282ms |
| TTS DNS | 8、0、0、0ms | 7、0、0、0ms |
| 服务端播放欠载 | 0次 / 0ms | 0次 / 0ms |
| 自然关房及进程退出 | PASS | PASS |

首PCM是服务端句子就绪后的指标，不是用户说完到扬声器响起。上述正常样本不构成长稳或历史故障根治证明。两轮SID为`RM_bHtAVeMp28FH`、`RM_quTE74noaTn5`；trace、日志和DNS元数据见`dns-cname-evidence/DNS_CNAME_TTL_PROBES_FINAL.json`。

发布后172.2秒只读复核：PID3529878、NRestarts0、磁盘/proc哈希一致；房间0、未结束job为0、清理队列0且健康；无Worker panic、无45000002。搜索/倾听两池PID与二进制、主池env/unit/DNS配置均未变化。首次状态读取的`current_main_matches=false`是比较包含新增SHA字段的对象与原三字段对象所致，已修读者按字段比较；原记录保留，不是实际进程漂移。

## 探针验收补正

此前Python探针功能结果写出后曾SIGABRT；主Worker未重启。探针未完整关闭音频流及远端已断开的Room FFI资源，已明确关闭、释放并要求进程退出后判PASS。旧失败及第一次修复等待EOS超时均保留；补验3轮旧现役+本次2轮新现役均exit0，未用强制退出或屏蔽错误。旧ASR回执已补注功能通过与进程退出证据的区别。

## 范围及回滚

这是主池共享ASR/TTS连接层修复。业务看门狗enforce名单仍仅真实尾号02000053及合成99999901；本次未扩大设备范围，未改Brain、数据库和设备配置。

- 成对备份：`/root/p003-business-watchdog-20261107/dns-cname-ttl-before`，包含发布前binary3dd0430a、env5c15e762及unit；摘要已复核。
- 源码回滚标签：`rollback/p003-pre-dns-cname-20261108` → `713f6f35`，已push。
- 回滚命令：`python3 /root/p003-business-watchdog-20261107/dns-cname-ttl-before/rollback-after-tests.py`。先核空房/无未结束job/当前SHA与配置未漂移，恢复本次发布前成对文件并验注册，其他池与数据不动；不使用更早50017或未发布59e包。

下一步继续对历史4.704秒DNS等待、386ms备用失败和流中停顿分别取同连接证据；搜索/倾听池须基于各自现役增量适配，不能复制本二进制覆盖。02000053真实配置应用与Android实听仍需真实设备证据。当前整体目标保持进行中。

署名：codex（OpenAI）| 2026-11-08 02:48 CST
