# 主13复核与采纳

Grok已核原八条经验及本地提交关系，未新增生产操作。采纳：发布前现役与当前运行明确区分；仅--check不写为执行过回滚；线上system_resolver成功不冒充自然故障备用接管；两套许可及快速阴性边界分别记录；增加首次resolver初始化缓存的条件。

对原评审第二条保留原文并校正：
- 固定545源码tts_xfyun.rs async_dns_enabled允许rust-worker或search_canary::is_candidate，不是只允许rust-worker；本次正式主池测试用rust-worker是真实分支入口。
- “倾听/搜索不要开hedge”仅能理解为本次主池发布不改其他池，不能升级成全项目永久禁令；现役倾听池自身代码/配置须按其回执读。
- voice_connect.rs connect的OnceLock<Option<TokioResolver>>确会缓存None，两个开关、固定TTS域名与managed stub条件均须核；本轮只沉淀检查方法，不操作服务器。

Grok署名模型由其自报，主13仅将其标为Grok只读复核，不冒称另有独立模型版本验证。
