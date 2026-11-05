# 语音上游故障取证

`network_watch.py` 是独立被动记录器，不加入RTC、不播放/合成语音、不改DNS与应用配置。Linux运行需要CAP_NET_RAW。先核脚本SHA与目标机真值，再在受控目录执行：

```sh
python3 network_watch.py --seconds 86400 --output /root/p003-transport-diagnostic-20261105/watch
```

最长24小时。`status.json`记录线程状态、入/出方向计数和到期时间。只有固定讯飞域名的DNS、对应IP的TCP包头以及Worker日志白名单字段会保存；不存DNS任意正文、TLS负载、音频或用户转写。遇DNS≥1000ms、TCP≥900ms、TLS/WS≥1500ms/超时、接收等待或欠载≥1000ms，保存前20/后15秒元数据。最多6份事件，每份最多8000条，旧事件轮转；`tail.json`也最多8000条。SIGTERM可结束并落尾记录。

`tcp_out`与`tcp_in`必须都非零才能声称双向抓取；只用ETH_P_IP的旧短探针漏出站，不能拿它确认SYN/ACK或重传。日志中的欠载仍可能包含已知的暂停计数边界，应与pause/resume对齐。

`tools/tts-transport-probe`是另一项主动实验：使用进程环境内的既有讯飞凭据，默认4轮，每轮旧connector/现役显式connector/既有异步解析各一次，轮次上限12。会消耗少量真实TTS配额，仅在内存消费合成音频，不播放、不接触设备。输出不含凭据、签名URL或音频，只含时序、地址和音频块长度。

构建与测试使用现有隔离Cargo缓存，不在生产安装编译器。结果的“ok”只证明该次调用，不代表历史故障根治。
