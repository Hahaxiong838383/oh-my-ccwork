/**
 * LLM Verifier 单测
 *
 * 全部 mock fetch，不真实网络调用
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runLlmVerifier } from "../src/services/verifier/llm-verifier";

const C_GOAL = { id: "goal", name: "目标达成", description: "测试用维度", weight: 1.0 };
const C_COVERAGE = { id: "coverage", name: "测试覆盖", description: "测试用维度", weight: 0.5 };

describe("llm-verifier", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("无 GEMINI_PROXY_KEY → 返回 null（不调用 fetch）", async () => {
    vi.stubEnv("GEMINI_PROXY_KEY", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await runLlmVerifier("test.src", "claim", {}, [C_GOAL]);

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("空 criteria → 返回 null", async () => {
    vi.stubEnv("GEMINI_PROXY_KEY", "test-key");
    const result = await runLlmVerifier("test.src", "claim", {}, []);
    expect(result).toBeNull();
  });

  it("fetch 成功 score=8 → confidence=0.8", async () => {
    vi.stubEnv("GEMINI_PROXY_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "8" } }] }),
      }),
    );

    const result = await runLlmVerifier("test.src", "claim done", { exitCode: 0 }, [C_GOAL]);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(0.8);
    expect(result!.perCriterion[0].id).toBe("goal");
    expect(result!.perCriterion[0].score).toBeCloseTo(0.8);
    expect(result!.tokenCost).toBe(305);
  });

  it("两个维度加权平均：goal=8(w1.0) + coverage=4(w0.5) → (0.8+0.2)/1.5", async () => {
    vi.stubEnv("GEMINI_PROXY_KEY", "test-key");
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        const score = callCount++ === 0 ? "8" : "4";
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: score } }] }),
        };
      }),
    );

    const result = await runLlmVerifier("test.src", "claim", {}, [C_GOAL, C_COVERAGE]);

    expect(result).not.toBeNull();
    // (0.8 * 1.0 + 0.4 * 0.5) / 1.5 = (0.8 + 0.2) / 1.5 ≈ 0.667
    expect(result!.confidence).toBeCloseTo(0.667, 2);
    expect(result!.tokenCost).toBe(610); // 2 * 305
  });

  it("fetch HTTP 500 → 该维度 fallback 0.5", async () => {
    vi.stubEnv("GEMINI_PROXY_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    const result = await runLlmVerifier("test.src", "claim", {}, [C_GOAL]);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(0.5);
  });

  it("fetch 返回非数字内容 → fallback 0.5", async () => {
    vi.stubEnv("GEMINI_PROXY_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "yes" } }] }),
      }),
    );

    const result = await runLlmVerifier("test.src", "claim", {}, [C_GOAL]);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeCloseTo(0.5);
  });

  it("score 超出范围 clamp：15 → 1.0, -3 → 0.0", async () => {
    vi.stubEnv("GEMINI_PROXY_KEY", "test-key");
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        const score = callCount++ === 0 ? "15" : "-3";
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: score } }] }),
        };
      }),
    );

    const result = await runLlmVerifier("test.src", "claim", {}, [C_GOAL, C_COVERAGE]);
    const scores = result!.perCriterion;
    expect(scores[0].score).toBeCloseTo(1.0);
    expect(scores[1].score).toBeCloseTo(0.0);
  });
});
