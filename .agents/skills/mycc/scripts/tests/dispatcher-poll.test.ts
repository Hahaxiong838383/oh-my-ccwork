/**
 * dispatcher poll / HTTP 接入测试
 *
 * 覆盖：
 * - poll timeoutMs=0 存在返回 envelope / 不存在立即 null
 * - poll 对损坏 JSON 容错（unlink 残留，返回 null）
 * - GET /api/task-status/:run_id：鉴权 / 存在性 / 无效 run_id
 * - POST /api/task-dispatch：鉴权 / 字段校验 / Location 头
 */

import { describe, it, expect } from "vitest";
import http from "http";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { poll } from "../src/services/dispatcher.js";
import type { ResultEnvelope } from "../src/services/envelope.js";

const TEST_TOKEN = "test-token-1234567890abcdef";

function buildEnvelope(run_id: string, task_id: string): ResultEnvelope {
  const now = new Date().toISOString();
  return {
    envelope_version: "0.4",
    run_id,
    task_id,
    engine: "codex",
    attempt: 1,
    started_at: now,
    finished_at: now,
    verdict: "success",
    summary: "test",
  };
}

function resultPathFor(run_id: string): string {
  return `/tmp/dispatch-result-${run_id}.json`;
}

describe("dispatcher.poll", () => {
  it("timeoutMs=0 + 文件存在 → 立即返回 envelope", async () => {
    const run_id = randomUUID();
    const envelope = buildEnvelope(run_id, "t-exists");
    const path = resultPathFor(run_id);
    writeFileSync(path, JSON.stringify(envelope), "utf8");

    try {
      const started = Date.now();
      const got = await poll(run_id, { timeoutMs: 0 });
      const elapsed = Date.now() - started;

      expect(got).not.toBeNull();
      expect(got!.run_id).toBe(run_id);
      expect(elapsed).toBeLessThan(500);
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it("timeoutMs=0 + 文件不存在 → 立即返回 null", async () => {
    const run_id = randomUUID();
    const path = resultPathFor(run_id);
    if (existsSync(path)) unlinkSync(path);

    const started = Date.now();
    const got = await poll(run_id, { timeoutMs: 0 });
    const elapsed = Date.now() - started;

    expect(got).toBeNull();
    expect(elapsed).toBeLessThan(200);
  });

  it("损坏 JSON → 返回 null 并 unlink 残留文件", async () => {
    const run_id = randomUUID();
    const path = resultPathFor(run_id);
    writeFileSync(path, "{not valid json", "utf8");

    const got = await poll(run_id, { timeoutMs: 0 });
    expect(got).toBeNull();
    // 残留文件应被自动清理
    expect(existsSync(path)).toBe(false);
  });

  it("合法 JSON 但非 envelope → 返回 null 并 unlink", async () => {
    const run_id = randomUUID();
    const path = resultPathFor(run_id);
    writeFileSync(path, JSON.stringify({ hello: "world" }), "utf8");

    const got = await poll(run_id, { timeoutMs: 0 });
    expect(got).toBeNull();
    expect(existsSync(path)).toBe(false);
  });
});

describe("HTTP /api/task-status 和 /api/task-dispatch", () => {
  async function startServer() {
    const originalPort = process.env.PORT;
    process.env.PORT = "0";
    const { HttpServer } = await import("../src/http-server.js");
    // 第 3 个参数传 token 直接进入 paired 状态，省去 /pair 流程
    const server = new HttpServer("ABC123", process.cwd(), TEST_TOKEN);
    await server.start();
    const address = (server as { server: http.Server }).server.address();
    const port = typeof address === "object" && address ? (address as { port: number }).port : 0;
    const restore = () => {
      server.stop();
      if (originalPort !== undefined) process.env.PORT = originalPort;
      else delete process.env.PORT;
    };
    return { server, port, restore };
  }

  function request(
    port: number,
    path: string,
    method: "GET" | "POST",
    body?: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: "localhost", port, path, method, headers },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({
            status: res.statusCode ?? 0,
            body: data,
            headers: res.headers,
          }));
        },
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  const auth = { Authorization: `Bearer ${TEST_TOKEN}` };

  it("task-status：未鉴权 → 401（不能通过 run_id 读取）", async () => {
    const { port, restore } = await startServer();
    try {
      const res = await request(port, `/api/task-status/${randomUUID()}`, "GET");
      expect(res.status).toBe(401);
    } finally {
      restore();
    }
  });

  it("task-status：鉴权 + 未知 run_id → 202 pending", async () => {
    const { port, restore } = await startServer();
    try {
      const run_id = randomUUID();
      const res = await request(port, `/api/task-status/${run_id}`, "GET", undefined, auth);
      expect(res.status).toBe(202);
      const parsed = JSON.parse(res.body);
      expect(parsed.status).toBe("pending");
      expect(parsed.run_id).toBe(run_id);
    } finally {
      restore();
    }
  });

  it("task-status：鉴权 + 已落盘 → 200 + envelope", async () => {
    const { port, restore } = await startServer();
    const run_id = randomUUID();
    const envelope = buildEnvelope(run_id, "t-http");
    const path = resultPathFor(run_id);
    writeFileSync(path, JSON.stringify(envelope), "utf8");
    try {
      const res = await request(port, `/api/task-status/${run_id}`, "GET", undefined, auth);
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body) as ResultEnvelope;
      expect(parsed.run_id).toBe(run_id);
      expect(parsed.envelope_version).toBe("0.4");
    } finally {
      if (existsSync(path)) unlinkSync(path);
      restore();
    }
  });

  it("task-status：非法 run_id（特殊字符）→ 400", async () => {
    const { port, restore } = await startServer();
    try {
      const res = await request(port, `/api/task-status/..%2Fetc`, "GET", undefined, auth);
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });

  it("task-status：空 run_id（trailing slash）→ 400", async () => {
    const { port, restore } = await startServer();
    try {
      const res = await request(port, `/api/task-status/`, "GET", undefined, auth);
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });

  it("task-dispatch：未鉴权 → 401", async () => {
    const { port, restore } = await startServer();
    try {
      const res = await request(
        port,
        "/api/task-dispatch",
        "POST",
        JSON.stringify({ task_id: "t", engine: "codex", prompt: "p" }),
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(401);
    } finally {
      restore();
    }
  });

  it("task-dispatch：Bearer 长度不等 → 401（timingSafeEqual 前置长度检查）", async () => {
    const { port, restore } = await startServer();
    try {
      const res = await request(
        port,
        "/api/task-dispatch",
        "POST",
        JSON.stringify({ task_id: "t", engine: "codex", prompt: "p" }),
        { "Content-Type": "application/json", Authorization: "Bearer short" },
      );
      expect(res.status).toBe(401);
    } finally {
      restore();
    }
  });

  it("task-dispatch：字段缺失 → 400", async () => {
    const { port, restore } = await startServer();
    try {
      const res = await request(
        port,
        "/api/task-dispatch",
        "POST",
        JSON.stringify({ task_id: "t" }),
        { "Content-Type": "application/json", ...auth },
      );
      expect(res.status).toBe(400);
      const parsed = JSON.parse(res.body);
      expect(parsed.error).toContain("missing");
    } finally {
      restore();
    }
  });

  it("task-dispatch：非法 engine → 400", async () => {
    const { port, restore } = await startServer();
    try {
      const res = await request(
        port,
        "/api/task-dispatch",
        "POST",
        JSON.stringify({ task_id: "t", engine: "openai", prompt: "p" }),
        { "Content-Type": "application/json", ...auth },
      );
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });

  it("task-dispatch：非法 JSON → 400", async () => {
    const { port, restore } = await startServer();
    try {
      const res = await request(
        port,
        "/api/task-dispatch",
        "POST",
        "{not json",
        { "Content-Type": "application/json", ...auth },
      );
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });
});
