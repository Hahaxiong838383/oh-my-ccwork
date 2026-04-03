/**
 * http-direct.ts — 直连 HTTP 请求（绕过系统代理）
 *
 * Node.js native fetch (undici) 在代理环境下会走代理，
 * 对局域网的 brain 服务需要用 http.request 直连。
 */

import http from "http";

function httpPostOnce(
  url: string,
  payload: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parseInt(parsed.port || "80", 10),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
          } catch {
            reject(new Error(`Invalid JSON: ${raw.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(120_000, () => {
      req.destroy(new Error("timeout 120s"));
    });
    req.write(payload);
    req.end();
  });
}

export async function httpPost(
  url: string,
  body: unknown,
  retries = 2,
): Promise<{ status: number; data: unknown }> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await httpPostOnce(url, payload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < retries && (msg.includes("socket hang up") || msg.includes("ECONNRESET"))) {
        const delay = (attempt + 1) * 3000;
        console.log(`[http] retry ${attempt + 1}/${retries} after ${delay}ms: ${msg}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

export function httpGet(url: string): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parseInt(parsed.port || "80", 10),
        path: parsed.pathname + parsed.search,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
          } catch {
            reject(new Error(`Invalid JSON: ${raw.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error("timeout 10s"));
    });
    req.end();
  });
}
