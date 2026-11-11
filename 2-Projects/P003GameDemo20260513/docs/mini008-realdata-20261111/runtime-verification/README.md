# 主13按现役运行时复验

固定运行源 ac21c2d75648a4fa4fc49b18adb2ef0f9a4f7e84。未部署功能，未改线上配置/DB/设备授权。本轮只在Brain服务器的独立临时目录与合成库执行归档代码，复用已安装依赖，无安装或生产服务重启。

只读核实主Brain为/usr/bin/node v22.22.2(SQLite3.51.2)，PM2用tsx --env-file=.env.local src/index.ts，PM2存储环境没有Ark范围键；Analytics单独使用/opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node v24.19.0(SQLite3.53.3)。不得将两服务运行时混为一谈。

| 实际执行运行时 | 测试 | 结果 |
|---|---|---|
| 现役Node22.22.2 | mini008 dashboard |16/16|
| 现役Node22.22.2 | 原telemetry |37/37|
| 现役Node22.22.2 | 主13独立HTTP/SQLite链路 |13/13|
| 现役Node22.22.2 | Ark state/runtime/proxy |16+7+4通过|
| 现役Analytics Node24.19.0 | Ark history |11/11|

最初用Node22执行history的11项全部在既有Analytics SQLite版本保护处失败(UNSAFE_ANALYTICS_SQLITE_VERSION)，原失败日志保留；真实Analytics服务用专用Node24，按该二进制重跑通过。没有放松保护、切换服务运行时、改数据库或修无关功能。所有临时JWT/事件仅用于隔离库，未发送生产设备上传接口。

源码包SHA64729d57c198a85756ee535dbe2a0d1b2e8607c0f276b9603af3669f5cac74cc，各日志SHA见JSON。实际生产/家长手机HTTP、小程序页面及真人数据仍未验；Grok最终独立审核仍缺，不能把主13执行Grok脚本冒称Grok本人最终复核。

发布脚本仍未执行。准备脚本新增Ark settings漂移检查；发布前重新取before并核完整源/配置/owner/grant，回滚不能整库回灌。

署名：codex（OpenAI）| 2026-11-11
