import { runKnowledgeSyncJob } from "../src/knowledge/knowledge-sync-job.ts";
const key = process.env.GEMINI_PROXY_KEY;
if (!key) { console.error("missing GEMINI_PROXY_KEY"); process.exit(1); }
const result = await runKnowledgeSyncJob({
  budgetUsd: 0.20,
  maxDocs: 30,
  allowlistPath: "./data/knowledge-allowlist.json",
  knowledgeDbPath: "./data/knowledge.db",
  geminiApiKey: key,
});
console.log(JSON.stringify({
  totalDocs: result.crawlerResult.totalDocs,
  newDocs: result.crawlerResult.newDocs,
  updatedDocs: result.crawlerResult.updatedDocs,
  skippedDocs: result.crawlerResult.skippedDocs,
  failedDocs: result.crawlerResult.failedDocs,
  docsProcessed: result.docsProcessed,
  docsExtracted: result.docsExtracted,
  docsFailed: result.docsFailed,
  factsInserted: result.factsInserted,
  totalCostUsd: Number(result.totalCostUsd.toFixed(6)),
  stoppedByBudget: result.stoppedByBudget,
  errorsCount: result.errors.length,
  errorsSample: result.errors.slice(0, 3),
}, null, 2));
