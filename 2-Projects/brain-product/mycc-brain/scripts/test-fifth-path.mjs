import { knowledgeSearch, shouldTriggerKnowledgeSearch, resetKnowledgeSearchCache } from "../src/knowledge/search.ts";
console.log("env KNOWLEDGE_SEARCH_ENABLED=", process.env.KNOWLEDGE_SEARCH_ENABLED);
console.log("trigger('futurus 产品文档怎么管理？')=", shouldTriggerKnowledgeSearch("futurus 产品文档怎么管理？"));
console.log("trigger('你好')=", shouldTriggerKnowledgeSearch("你好"));
const hits = await knowledgeSearch("产品研究部 文档 管理", 5);
console.log("hits.length=", hits.length);
for (const h of hits) {
  console.log("-", h.namespace, "|", h.content.slice(0, 60));
}
// force 模式
const forceHits = await knowledgeSearch("产品文档", 5, { forceEnable: true });
console.log("forceHits.length=", forceHits.length);
resetKnowledgeSearchCache();
