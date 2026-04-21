import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRouter, resetRouterRegistryForTesting } from "../handlers/router";
import { clearTelemetry } from "../providers/telemetry";

type Captured = { statusCode: number; headers: Record<string, string>; body: string };

function mockRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { statusCode: 0, headers: {}, body: "" };
  const res = {
    statusCode: 0,
    writeHead(status: number, headers?: Record<string, string>) {
      captured.statusCode = status;
      if (headers) Object.assign(captured.headers, headers);
      return this;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") captured.body += chunk;
      return this;
    },
    setHeader() {
      return this;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

const mockReq = {} as IncomingMessage;

async function call(url: string, method = "GET"): Promise<Captured> {
  const { res, captured } = mockRes();
  const handled = await handleRouter(mockReq, res, url, method);
  if (!handled) throw new Error(`not handled: ${method} ${url}`);
  return captured;
}

test("handleRouter 仅拦 GET，其他方法返回 false", async () => {
  const { res } = mockRes();
  const handled = await handleRouter(mockReq, res, "/v1/router/select?flow=FLOW&slot=chat", "POST");
  assert.equal(handled, false);
});

test("GET /v1/router/stats 返回 getDecisionStats 结构", async () => {
  clearTelemetry();
  resetRouterRegistryForTesting();
  const c = await call("/v1/router/stats");
  assert.equal(c.statusCode, 200);
  const body = JSON.parse(c.body);
  assert.ok("perFlow" in body);
  assert.ok("fallbackRate" in body);
  assert.ok("failClosedRate" in body);
  assert.equal(body.fallbackRate, 0);
  assert.equal(body.failClosedRate, 0);
});

test("GET /v1/router/select?flow=INVALID&slot=chat → 400 INVALID_FLOW", async () => {
  resetRouterRegistryForTesting();
  const c = await call("/v1/router/select?flow=INVALID&slot=chat");
  assert.equal(c.statusCode, 400);
  assert.equal(JSON.parse(c.body).error, "INVALID_FLOW");
});

test("GET /v1/router/select?flow=FLOW&slot=xxx → 400 INVALID_SLOT", async () => {
  resetRouterRegistryForTesting();
  const c = await call("/v1/router/select?flow=FLOW&slot=xxx");
  assert.equal(c.statusCode, 400);
  assert.equal(JSON.parse(c.body).error, "INVALID_SLOT");
});

test("GET /v1/router/select?flow=FLOW&slot=chat（默认 fallback）→ 200 + provider", async () => {
  resetRouterRegistryForTesting();
  clearTelemetry();
  const c = await call("/v1/router/select?flow=FLOW&slot=chat");
  assert.equal(c.statusCode, 200);
  const body = JSON.parse(c.body);
  assert.ok(body.provider);
  assert.equal(body.provider.id, "local-fallback");
  assert.ok(Array.isArray(body.fallbackPath));
  assert.equal(typeof body.durationMs, "number");
});

test("GET /v1/router/unknown 返回 false 让下一 handler 处理", async () => {
  const { res } = mockRes();
  const handled = await handleRouter(mockReq, res, "/v1/router/foo", "GET");
  assert.equal(handled, false);
});

// ============================================================
// B14-4c: /decisions (批量) + /policy (SSoT)
// ============================================================

test("GET /v1/router/policy → 200 + 4 flows × 5 slots 静态策略", async () => {
  const c = await call("/v1/router/policy");
  assert.equal(c.statusCode, 200);
  const body = JSON.parse(c.body);
  assert.ok(body.policy);
  for (const flow of ["FLOW", "BOREDOM", "ANXIETY", "APATHY"]) {
    assert.ok(body.policy[flow], `missing flow ${flow}`);
    for (const slot of ["chat", "extract", "embed", "vision", "tool_use"]) {
      assert.ok(body.policy[flow][slot], `missing ${flow}.${slot}`);
    }
  }
});

test("GET /v1/router/decisions?flow=FLOW → 200 + 5 slots decisions", async () => {
  resetRouterRegistryForTesting();
  clearTelemetry();
  const c = await call("/v1/router/decisions?flow=FLOW");
  assert.equal(c.statusCode, 200);
  const body = JSON.parse(c.body);
  assert.equal(body.flow, "FLOW");
  assert.ok(body.decisions);
  for (const slot of ["chat", "extract", "embed", "vision", "tool_use"]) {
    const d = body.decisions[slot];
    assert.ok(d, `missing decision for ${slot}`);
    if ("provider" in d) {
      assert.equal(d.provider.id, "local-fallback");
      assert.ok(Array.isArray(d.fallbackPath));
      assert.equal(typeof d.durationMs, "number");
    }
  }
});

test("GET /v1/router/decisions?flow=INVALID → 400 INVALID_FLOW", async () => {
  resetRouterRegistryForTesting();
  const c = await call("/v1/router/decisions?flow=INVALID");
  assert.equal(c.statusCode, 400);
  assert.equal(JSON.parse(c.body).error, "INVALID_FLOW");
});
