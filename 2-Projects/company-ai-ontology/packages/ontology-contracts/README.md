# Ontology Contracts

公司 AI Ontology 的稳定定义和编译契约。该包不连接数据库、不执行写回，只负责读取定义、结构校验、内容寻址、兼容性分析、Event Envelope 和 Data/Logic/Action 工具契约校验。

## 命令

```bash
npm test
npm run compile
```

默认定义目录为 `definitions/`。编译成功会输出 schema version、内容 hash、元素数量和兼容性摘要；校验失败返回非零退出码。
