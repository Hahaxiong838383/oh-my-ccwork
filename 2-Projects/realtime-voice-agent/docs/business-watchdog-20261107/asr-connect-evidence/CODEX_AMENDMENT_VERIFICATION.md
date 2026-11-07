# Codex 对证据增补的核对
Grok173终态同意有回滚的主池受控发布，要求release普通/ordered三通道与自然关房复验后才保留上线。原171/172/173报告原样保存。
报告的“当前HEAD713/测试未提交”是读取时快照：测试与证据随后已提交dc13e461并push；运行source仍713f6f35，source68项核同，release3dd未包含测试增量。
评审读取后，正式release探针的metrics断言进一步收紧为必须实际包含eou、llm、tts三种k，替换此前仅packets>0；未改变Worker运行源码或部署脚本。本目录保存实际使用脚本SHA。额外提供发布后rollback脚本，供正式探针失败时在空闲/无漂移条件下退50017+旧env。所有版本边界以证据时间及源SHA为准。
署名：codex（OpenAI）| 2026-11-08 CST
