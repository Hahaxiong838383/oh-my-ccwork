# REA 6.7.0 安装与验收

时间：2026-10-21T01:15:54.076292+00:00；执行：Codex，独立运行验收：Hermes（Codeg会话242）。

完成官方发布包、独立Node24.22.0及匹配技能42安装；配置Claude/Codex/Grok/Hermes/Gemini全局MCP。npm锁文件中REA完整性与先前核验SRI相同，Node官方SHASUMS256校验通过。未安装上游源码或fork。统一入口为 /home/hahaxiong83/.local/bin/rea，其绝对shebang绑定专用Node；全局默认Node仍22.14.0。

验收：配置内存解析后剔除本次rea条目，其他语义哈希与安装前一致；原生setup备份路径已保留。3个技能目录各7文件与包内原件全部一致。CLI正例25节点/35边，3份JS源码hash一致，main→logic导入以及rea:normalize invokes/handles关系正确；缺失路径负例exit1/invalid_request/ENOENT。直接stdio MCP tools/list为207，真实tools/call正例graph与CLI完全一致、负例isError=true。Hermes新会话加载原生REA工具、调用summary与分析视图并通过负例，目标sha256与主代理一致。

本轮初始直接MCP探针按错误的path字段断言退出，尚未发送分析调用；读取实际schema后改为input_path再完成正反例，已写入调用指南。Hermes报告中会话工具目录209并不证明版本漂移，服务实际tools/list207与技能一致；Hermes模块投影视图未取到main→logic单条边，但主代理完整CLI和MCP图已经按该边验证，无需从模块数量推断。

范围：真实客户端会话只验Hermes；其他3个已存在客户端核配置/技能和相同启动链。Gemini准备配置但本轮未找到可执行文件。外部原生/Android引擎未配置，doctor环境总项为false，不影响已验JS/Electron静态能力。Frida17.23.2依赖安装脚本仅按精确版本批准，原生import成功，未进行注入。

证据：2026-10-21-acceptance.json；安装路径与版本真值：../installation.json；调用方法：../usage.md。历史首次调查中“尚未安装”记录保留为历史快照，由本报告覆盖当前状态。
