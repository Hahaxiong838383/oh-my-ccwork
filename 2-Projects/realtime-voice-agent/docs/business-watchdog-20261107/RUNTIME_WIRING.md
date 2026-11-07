# 业务无进展保护：普通池实际链路实现记录

**状态：主池源码已接线，Linux523/523通过；尚未形成可发布版本。没有生产部署、重启、设备配置变化或房间清理。**

## 已完成

- 修复首帧模型：ready不再当作业务progress；启动截止后的晚帧不能复活；有效首帧前的真实输入对照保留。空音频帧不能解除启动保护。
- Runtime仅由受信job metadata中的voice_idle构造；校验整数5000..300000及cfg-N。缺失/非法策略只观察。异常voice_idle字段不会导致trace/首句合同整体反序列化丢失。
- 新配置：P003_BUSINESS_WATCHDOG_MODE=off/observe/enforce（默认off）；P003_BUSINESS_WATCHDOG_DEVICE_ALLOWLIST完整SN列表（空或不命中关闭，不支持通配符）。此键未在现役环境设置。
- job每秒真正evaluate；pipeline传入有效fresh VAD、实际captured PCM变化。无ASR final不单独导致关房，静音/零帧/重复ready/不变busy不续命。主池不因为metadata出现listening对象就获得倾听保护；倾听池另适配有效租约。
- connect和publish共用assignment起的单调60秒预算，来源是既有StartupParticipant预算常量；订轨/prebuild/无首帧阶段继续受监控。未知策略/观察模式不以新增启动门自动关闭。timeout_at对已过期且立即ready的future需前后显式检查，新增失败测试已证实并修复。
- 原pipeline liveness也改成同一assignment单调毫秒，不再比较墙钟。保留5秒停跳阈值与Nov6生命周期修复。
- 搜索actor以watch传真实绝对截止，待HTTP接单4.5秒、原轮询80秒、恢复时采用真实speech.expires；轮询不刷新截止，epoch不同/已结束actor不保活。busy、auto_pending、300秒上下文和仅缓存的remainder不保活；正常语音主循环不等待HTTP。
- 设备命令沿原8秒/accepted后24秒；有序首句沿已接受begin的协议预算（现有默认7秒）；回复首段保护从turn.started算现有LLM HTTP30秒+讯飞连接10秒，持续实际PCM另记进展。阈值及其他播放门组合仍须真实RTC回归，不把模型阈值当真人验收。
- 新RoomService回读：先按原SID核名，名字对应其他SID则不删除；DeleteRoom后重新ListRooms，200但原SID仍在标Pending；读取错误/无效响应标Unavailable。整个前台校验8秒上界。当前只改善前台核验，主池独立持久重试还没有接入。

## 测试与失败保留

全部运行在既有Linux离线Rust构建环境，无安装依赖。

| 阶段 | 实际结果 |
|---|---|
| 首帧新用例未修复 | 13通过/2行为失败；修复后15通过 |
| Runtime骨架红测 | 510通过/4行为失败；接线后514通过 |
| SID校验骨架红测 | 515通过/4行为失败；实现后519通过 |
| 过期startup future补测 | 519通过/2失败：一条真实边界、一条搜索fixture缺automatic_for_ms；分别修复 |
| 搜索真实HTTP期限补测 | 520通过/1失败：测试在解锁接单HTTP前错误要求80秒轮询阶段，纠正为先验4.5秒，再解锁并验80秒不续期 |
| 最终当前源码 | 523通过/0失败；含原TTS连接恢复、生命周期、容量和搜索回归 |

不是只改测试期望：静音首帧与晚帧行为改动有外部红测；原ready测试helper明确补一次真实progress，新增无progress独立用例同时约束。真实HTTP用例沿实际actor经历提交→轮询→claim→receipt，校验主循环无阻塞及绝对期限不被成功轮询刷新。

源码及日志SHA见RUNTIME_WIRING_EVIDENCE.json。私有完整取证目录/Users/fu-121/.local/state/p003-business-watchdog-20261107/；build.py各次mode都有输入清单和日志，首次错误不覆盖。

## 发布前仍必须完成

1. 主池持久关闭意图及独立重试，不能让API失败再次留下设备旧房。复用已有reconciler前必须去掉候选window授权对主池active房的误用；否则会误删健康房。需要独立单测及失败注入。
2. 主池固定SHA独立代码复核、release/ABI构建、真实RTC无帧/静音/正常对话/长输入/长播放/搜索/删除失败对照；当前前台RoomService测试是实际localhost HTTP，不是生产SFU实验。ListRooms空响应形状上线前现场核验。
3. 倾听候选树的实际生产SHA及专属回滚核验，移植最小改动并接有效租约。普通池不代替倾听池验收。
4. Brain配置UI渲染、受信策略实际签发、目标设备应用revision；单SN观察后执行。缺策略观察不算最终交付。
5. 现存旧房先采新鲜进展，按精确SID受控处理并验证两名参与者和容量释放；不能用19:10旧音量推断当下空闲，不能在签新票时踢旧房。
6. 原始输入异常与后12票断点仍需同trace端侧/服务器证据；本保护不冒称根治所有TTS/网络/Android问题。

源回滚标签rollback/p003-business-watchdog-pre-20261107仍保留；生产实际exe/env/unit在/root/p003-business-watchdog-20261107/rollback-before。若将来发布，回滚先关闭新旗，再按该次发布记录恢复当前基线，不退掉11月6日修复，不回灌数据库。

署名：codex（OpenAI）| 2026-11-07T22:36:50+08:00
