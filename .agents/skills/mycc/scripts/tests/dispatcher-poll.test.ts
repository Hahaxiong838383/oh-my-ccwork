/**
 * dispatcher poll / HTTP 接入测试
 *
 * 覆盖：
 * 1. poll(run_id, { timeoutMs: 0 }) —— 文件存在时立即返回 envelope
 * 2. poll(run_id, { timeoutMs: 0 }) —— 文件不存在时立即返回 null（不等待）
 * 3. GET /api/task-status/:run_id —— 不存在返回 202 pending
 * 4. GET /api/task-status/:run_id —— 已落盘返回 200 + envelope
 * 5. POST /api/task-dispatch —— 缺字段 400，未鉴权 401
 */

import { describe, it, expect } from "vitest";
import http from "http";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { poll } from "../src/services/dispatcher.js";
import type { ResultEnvelope } from "../src/services/envelope.js";

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

describe("dispatcher.poll timeoutMs=0", () => {
  it("文件存在 → 立即返回 envelope（单次探测）", async () => {
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
      expect(got!.task_id).toBe("t-exists");
      // 单次探测必须瞬间返回（不得进入 5s 轮询间隔）
      expect(elapsed).toBeLessThan(500);
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it("文件不存在 → 立即返回 null（不进入等待循环）", async () => {
    const run_id = randomUUID();
    const path = resultPathFor(run_id);
    if (existsSync(path)) unlinkSync(path);

    const started = Date.now();
    const got = await poll(run_id, { timeoutMs: 0 });
    const elapsed = Date.now() - started;

    expect(got).toBeNull();
    expect(elapsed).toBeLessThan(200);
  });
});

describe("HTTP /api/task-status 和 /api/task-dispatch", () => {
  async function startServer() {
    const originalPort = process.env.PORT;
    process.env.PORT = "0";
    const { HttpServer } = await import("../src/http-server.js");
    const server = new HttpServer("ABC123", process.cwd());
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
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: "localhost", port, path, method, headers },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  it("GET /api/task-status/<未知 run_id> → 202 pending", async () => {
    const { port, restore } = await startServer();
    try {
      const run_id = randomUUID();
      const res = await request(port, `/api/task-status/${run_id}`, "GET");
      expect(res.status).toBe(202);
      const parsed = JSON.parse(res.body);
      expect(parsed.status).toBe("pending");
      expect(parsed.run_id).toBe(run_id);
    } finally {
      restore();
    }
  });

  it("GET /api/task-status/<已落盘 run_id> → 200 + envelope", async () => {
    const { port, restore } = await startServer();
    const run_id = randomUUID();
    const envelope = buildEnvelope(run_id, "t-http");
    const path = resultPathFor(run_id);
    writeFileSync(path, JSON.stringify(envelope), "utf8");
    try {
      const res = await request(port, `/api/task-status/${run_id}`, "GET");
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body) as ResultEnvelope;
      expect(parsed.run_id).toBe(run_id);
      expect(parsed.task_id).toBe("t-http");
      expect(parsed.envelope_version).toBe("0.4");
    } finally {
      if (existsSync(path)) unlinkSync(path);
      restore();
    }
  });

  it("GET /api/task-status/ （空 run_id）→ 400", async () => {
    const { port, restore } = await startServer();
    try {
      const res = await request(port, `/api/task-status/`, "GET");
      expect(res.status).toBe(400);
    } finally {
      restore();
    }
  });

  it("POST /api/task-dispatch 未鉴权 → 401", async () => {
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
});
