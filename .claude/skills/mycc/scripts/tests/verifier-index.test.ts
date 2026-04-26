/**
 * Verifier 主入口 e2e（不起服务，直接调函数）
 */

import { describe, it, expect, beforeEach } from "vitest";
import { verify, _resetCache, statsSnapshot } from "../src/services/verifier/index";
import { _reset as resetStats } from "../src/services/verifier/stats";

describe("verifier · index", () => {
  beforeEach(() => {
    _resetCache();
    resetStats();
  });

  it("exit code 非 0 → cheap layer 拒绝（dry-run 仍放行业务，但标记 wouldHaveBlocked）", async () => {
    const r = await verify(
      {
        source: "mycc.task-log",
        claim: "task done",
        evidence: { exitCode: 1 },
      },
      process.cwd(),
    );
    expect(r.layer).toBe("cheap");
    expect(r.mode).toBe("dry-run");
    expect(r.accepted).toBe(true); // dry-run 永远放行
    expect(r.wouldHaveBlocked).toBe(true); // 但标记"会拦截"
    expect(r.tokenCost).toBe(0);
  });

  it("无信号 → LLM layer（无 key 时静默放行）+ 写缓存", async () => {
    const req = {
      source: "mycc.route",
      claim: "route to gemini",
      evidence: { stdout: "all good" },
    };
    const r1 = await verify(req, process.cwd());
    // 无 GEMINI_PROXY_KEY → runLlmVerifier 返回 null，layer 仍记为 llm
    expect(r1.layer).toBe("llm");
    expect(r1.accepted).toBe(true);

    const r2 = await verify(req, process.cwd());
    expect(r2.layer).toBe("cache");
  });

  it("stats 累计正常", async () => {
    await verify(
      { source: "mycc.task-log", claim: "x", evidence: { exitCode: 1 } },
      process.cwd(),
    );
    await verify(
      { source: "mycc.route", claim: "y", evidence: {} },
      process.cwd(),
    );
    const snap = statsSnapshot();
    expect(snap.totalCalls).toBe(2);
    expect(snap.wouldHaveBlocked).toBe(1);
    expect(snap.byLayer.cheap).toBe(1);
    expect(snap.byLayer.llm).toBe(1);
    expect(snap.tokenCost).toBe(0);
  });
});
