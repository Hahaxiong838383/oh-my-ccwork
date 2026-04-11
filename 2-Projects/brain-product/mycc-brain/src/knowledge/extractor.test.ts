/**
 * extractor.test.ts — 通过注入 fetchImpl 测试 extractFacts()。
 *
 * 不真调 Gemini Flash；所有测试构造 mock response。
 * 覆盖：成本估算 / validateFact / parse / confidence 过滤 / JSON fence / 预算 / 重试。
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  extractFacts,
  estimateCostUsd,
  validateFact,
  callGeminiFlash,
  BudgetExceededError,
  type ExtractorOptions,
  type GeminiClientConfig,
  type ExtractInput,
  type FetchFn,
} from "./extractor.js";

const CLIENT: GeminiClientConfig = {
  baseUrl: "http://fake-proxy.local/v1",
  apiKey: "fake-key",
  model: "gemini-2.5-flash",
  maxTokens: 4096,
  temperature: 0.2,
};

const INPUT: ExtractInput = {
  docToken: "d1",
  docTitle: "Test",
  contentHash: "hash1",
  content: "公司的愿景是 X。使命是 Y。",
};

function makeFetch(response: unknown, status = 200): FetchFn {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
    text: async () => JSON.stringify(response),
  })) as unknown as FetchFn;
}

function makeFlakyFetch(
  failures: number,
  response: unknown,
): { fn: FetchFn; getCalls: () => number } {
  let calls = 0;
  const fn = (async () => {
    calls++;
    if (calls <= failures) {
      throw new Error(`transient-${calls}`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    };
  }) as unknown as FetchFn;
  return { fn, getCalls: () => calls };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("estimateCostUsd: known pricing yields expected value", () => {
  const cost = estimateCostUsd(100_000, 100_000);
  // 100k in * 0.075/1M + 100k out * 0.3/1M = 0.0075 + 0.03 = 0.0375
  assert.ok(cost > 0.037 && cost < 0.038);
});

test("validateFact: accepts valid fact", () => {
  assert.equal(
    validateFact({
      content: "x",
      keywords: ["a"],
      confidence: 0.9,
      namespace: "ns",
    }),
    true,
  );
});

test("validateFact: rejects missing namespace", () => {
  assert.equal(
    validateFact({ content: "x", keywords: ["a"], confidence: 0.9 }),
    false,
  );
});

test("validateFact: rejects confidence out of range", () => {
  assert.equal(
    validateFact({
      content: "x",
      keywords: ["a"],
      confidence: 1.5,
      namespace: "n",
    }),
    false,
  );
  assert.equal(
    validateFact({
      content: "x",
      keywords: ["a"],
      confidence: -0.1,
      namespace: "n",
    }),
    false,
  );
});

test("validateFact: rejects non-string keywords", () => {
  assert.equal(
    validateFact({
      content: "x",
      keywords: ["a", 42],
      confidence: 0.9,
      namespace: "n",
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// callGeminiFlash
// ---------------------------------------------------------------------------

test("callGeminiFlash: HTTP non-OK throws with body excerpt", async () => {
  const fetchMock = makeFetch({ error: "rate-limited" }, 429);
  await assert.rejects(
    () => callGeminiFlash(CLIENT, "sys", "user", fetchMock),
    /Gemini Flash HTTP 429/,
  );
});

// ---------------------------------------------------------------------------
// extractFacts 主流程
// ---------------------------------------------------------------------------

test("extractFacts: parses valid response", async () => {
  const mockResp = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            facts: [
              {
                content: "愿景是X",
                keywords: ["愿景"],
                confidence: 0.95,
                namespace: "公司/愿景",
              },
            ],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 200, completion_tokens: 50 },
  };
  const options: ExtractorOptions = { client: CLIENT, budgetUsd: 1.0 };
  const result = await extractFacts(INPUT, options, 0, makeFetch(mockResp));
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].content, "愿景是X");
  assert.equal(result.tokenIn, 200);
  assert.equal(result.tokenOut, 50);
  assert.ok(result.costUsd > 0);
  assert.equal(result.docToken, "d1");
  assert.equal(result.contentHash, "hash1");
});

test("extractFacts: filters confidence < 0.85 (T4 tweak)", async () => {
  const mockResp = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            facts: [
              {
                content: "高置信",
                keywords: ["a"],
                confidence: 0.9,
                namespace: "n",
              },
              {
                content: "临界",
                keywords: ["b"],
                confidence: 0.84,
                namespace: "n",
              },
              {
                content: "低置信",
                keywords: ["c"],
                confidence: 0.7,
                namespace: "n",
              },
            ],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 200, completion_tokens: 80 },
  };
  const result = await extractFacts(
    INPUT,
    { client: CLIENT, budgetUsd: 1.0 },
    0,
    makeFetch(mockResp),
  );
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].content, "高置信");
});

test("extractFacts: empty facts on parse failure", async () => {
  const mockResp = {
    choices: [{ message: { content: "not json at all" } }],
    usage: { prompt_tokens: 200, completion_tokens: 10 },
  };
  const result = await extractFacts(
    INPUT,
    { client: CLIENT, budgetUsd: 1.0 },
    0,
    makeFetch(mockResp),
  );
  assert.equal(result.facts.length, 0);
  // 但元数据应完整
  assert.equal(result.tokenIn, 200);
  assert.equal(result.tokenOut, 10);
});

test("extractFacts: strips ```json fence", async () => {
  const mockResp = {
    choices: [
      {
        message: {
          content:
            '```json\n{"facts":[{"content":"X","keywords":["a"],"confidence":0.9,"namespace":"n"}]}\n```',
        },
      },
    ],
    usage: { prompt_tokens: 200, completion_tokens: 50 },
  };
  const result = await extractFacts(
    INPUT,
    { client: CLIENT, budgetUsd: 1.0 },
    0,
    makeFetch(mockResp),
  );
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].content, "X");
});

test("extractFacts: throws BudgetExceededError when over budget", async () => {
  const bigInput: ExtractInput = {
    ...INPUT,
    content: "x".repeat(100_000_000),
  };
  await assert.rejects(
    () =>
      extractFacts(
        bigInput,
        { client: CLIENT, budgetUsd: 0.01 },
        0,
        makeFetch({}),
      ),
    BudgetExceededError,
  );
});

test("extractFacts: accumulatedCost pushes over budget", async () => {
  await assert.rejects(
    () =>
      extractFacts(
        INPUT,
        { client: CLIENT, budgetUsd: 0.001 },
        0.001,
        makeFetch({}),
      ),
    BudgetExceededError,
  );
});

test("extractFacts: retries transient failures and eventually succeeds", async () => {
  const mockResp = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            facts: [
              {
                content: "ok",
                keywords: ["a"],
                confidence: 0.95,
                namespace: "n",
              },
            ],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
  const { fn, getCalls } = makeFlakyFetch(2, mockResp);
  const result = await extractFacts(
    INPUT,
    { client: CLIENT, budgetUsd: 1.0 },
    0,
    fn,
  );
  assert.equal(getCalls(), 3);
  assert.equal(result.facts.length, 1);
});

test("extractFacts: throws after 3 failed attempts", async () => {
  const { fn, getCalls } = makeFlakyFetch(5, {});
  await assert.rejects(
    () =>
      extractFacts(INPUT, { client: CLIENT, budgetUsd: 1.0 }, 0, fn),
    /extractFacts failed after 3 attempts/,
  );
  assert.equal(getCalls(), 3);
});

test("extractFacts: empty facts array when response has no facts key", async () => {
  const mockResp = {
    choices: [{ message: { content: JSON.stringify({ other: "data" }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  };
  const result = await extractFacts(
    INPUT,
    { client: CLIENT, budgetUsd: 1.0 },
    0,
    makeFetch(mockResp),
  );
  assert.equal(result.facts.length, 0);
});
