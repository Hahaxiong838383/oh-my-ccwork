# v389 服务端核对与恢复验收

主文档：[面向安卓的最终回执](P003_V389_语音恢复_服务端核对与异常联调回执_20261110.md)。最终状态`SCOPED_SERVER_SDK_PASS_ANDROID_PENDING`。

15条历史trace、7个SDK场景，两轮共10次执行。首夹具失败及修正后复验同时保留。主执行实际跑测试；Grok独立复核。意见差异、历史状态覆盖关系和误读纠正在[REVIEW_RESOLUTION.md](REVIEW_RESOLUTION.md)。

本目录只包含脱敏结构、诊断源码和证据hash；原始语音、用户正文、凭据、历史完整日志不入仓。部分hash指向受控私有状态目录，缺原件时不能凭摘要宣称再次复验。

`probe.py`及`isolated-runner.py`是本次固定SHA的私有SFU诊断夹具，依赖既有服务器诊断Python环境、受控ASR/TTS配置和本轮夹具文件。不是生产发布脚本。不得直接更改预期SHA绕过检查；重复运行先归档既有结果，检查loopback端口空闲及当前二进制并记录新版本。只准私有SFU，不注册生产同名agent；capacity=1只改测试进程。

未覆盖物理Android4项故障注入、同房Worker替换、旧publication本地拒绝、突然进程崩溃后的孤房恢复、倾听候选准入/满载路由。历史e4d3ae97无final根因尚未明确。回滚与现役保护见[ROLLBACK_AND_SCOPE.md](ROLLBACK_AND_SCOPE.md)。
