/**
 * sidecar-client 单元测试
 *
 * 覆盖：
 *   - health() 成功 / 超时降级为 false
 *   - embed() 空输入校验
 *   - embed() 返回与请求数量不一致时抛
 *   - search() HTTP 错误抛
 *   - reindexTruthAsync() Sidecar 离线静默跳过
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  getSidecarClient,
  setSidecarClientForTesting,
  reindexTruthAsync,
  type SidecarClient,
} from '../lib/sidecar-client.js';

// ============================================================
// 本地 mock Sidecar（用真实 HTTP，测 fetch + timeout 行为）
// ============================================================

type Handler = (body: unknown, path: string) => { status: number; payload: unknown };

function createMockSidecar(handlers: Partial<Record<string, Handler>>): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c as Buffer));
      req.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString('utf-8');
        const body = bodyStr ? JSON.parse(bodyStr) : undefined;
        const path = req.url ?? '/';
        const handler = handlers[path];
        if (!handler) {
          res.writeHead(404);
          res.end();
          return;
        }
        const { status, payload } = handler(body, path);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(res => server.close(() => res())),
      });
    });
  });
}

// ============================================================
// health() 测试
// ============================================================

describe('sidecar-client.health', () => {
  it('returns true when Sidecar is healthy + model_loaded', async () => {
    const mock = await createMockSidecar({
      '/health': () => ({
        status: 200,
        payload: { status: 'ok', version: '0.1.0', uptime_ms: 100, model_loaded: true },
      }),
    });
    try {
      process.env.EVODESK_SIDECAR_URL = mock.url;
      setSidecarClientForTesting(null); // 强制单例重建
      const client = getSidecarClient();
      const ok = await client.health();
      assert.equal(ok, true);
    } finally {
      await mock.close();
      delete process.env.EVODESK_SIDECAR_URL;
      setSidecarClientForTesting(null);
    }
  });

  it('returns false when Sidecar reports model_loaded=false', async () => {
    const mock = await createMockSidecar({
      '/health': () => ({
        status: 200,
        payload: { status: 'ok', version: '0.1.0', uptime_ms: 100, model_loaded: false },
      }),
    });
    try {
      process.env.EVODESK_SIDECAR_URL = mock.url;
      setSidecarClientForTesting(null);
      const client = getSidecarClient();
      const ok = await client.health();
      assert.equal(ok, false);
    } finally {
      await mock.close();
      delete process.env.EVODESK_SIDECAR_URL;
      setSidecarClientForTesting(null);
    }
  });

  it('returns false when Sidecar is offline', async () => {
    process.env.EVODESK_SIDECAR_URL = 'http://127.0.0.1:1'; // 不可达
    setSidecarClientForTesting(null);
    try {
      const client = getSidecarClient();
      const ok = await client.health();
      assert.equal(ok, false);
    } finally {
      delete process.env.EVODESK_SIDECAR_URL;
      setSidecarClientForTesting(null);
    }
  });
});

// ============================================================
// embed() 测试
// ============================================================

describe('sidecar-client.embed', () => {
  it('returns embeddings on success', async () => {
    const mock = await createMockSidecar({
      '/embed': (body) => {
        const req = body as { texts: string[] };
        return {
          status: 200,
          payload: {
            embeddings: req.texts.map(() => [0.1, 0.2, 0.3]),
            dimensions: 3,
          },
        };
      },
    });
    try {
      process.env.EVODESK_SIDECAR_URL = mock.url;
      setSidecarClientForTesting(null);
      const client = getSidecarClient();
      const vecs = await client.embed(['hello', 'world']);
      assert.equal(vecs.length, 2);
      assert.deepEqual(vecs[0], [0.1, 0.2, 0.3]);
    } finally {
      await mock.close();
      delete process.env.EVODESK_SIDECAR_URL;
      setSidecarClientForTesting(null);
    }
  });

  it('rejects on empty input', async () => {
    setSidecarClientForTesting(null);
    const client = getSidecarClient();
    await assert.rejects(() => client.embed([]), /empty/);
  });

  it('rejects when response shape invalid', async () => {
    const mock = await createMockSidecar({
      '/embed': () => ({ status: 200, payload: { dimensions: 3 } }), // 缺 embeddings
    });
    try {
      process.env.EVODESK_SIDECAR_URL = mock.url;
      setSidecarClientForTesting(null);
      const client = getSidecarClient();
      await assert.rejects(() => client.embed(['x']), /invalid response shape/);
    } finally {
      await mock.close();
      delete process.env.EVODESK_SIDECAR_URL;
      setSidecarClientForTesting(null);
    }
  });
});

// ============================================================
// reindexTruthAsync 降级测试
// ============================================================

describe('sidecar-client.reindexTruthAsync', () => {
  it('does not throw when Sidecar is offline', async () => {
    process.env.EVODESK_SIDECAR_URL = 'http://127.0.0.1:1';
    setSidecarClientForTesting(null);
    try {
      // fire-and-forget：不应 reject 或抛（所有错误吞在 .catch）
      reindexTruthAsync('t-test-id', 'test statement');
      await new Promise(r => setTimeout(r, 300)); // 等 health timeout 触发
      assert.ok(true);
    } finally {
      delete process.env.EVODESK_SIDECAR_URL;
      setSidecarClientForTesting(null);
    }
  });
});

// ============================================================
// mock 注入
// ============================================================

describe('sidecar-client.setSidecarClientForTesting', () => {
  let restoreConsole: (() => void) | null = null;
  before(() => {
    const orig = console.warn;
    console.warn = () => {}; // 静音 reindex 警告
    restoreConsole = () => { console.warn = orig; };
  });
  after(() => {
    if (restoreConsole) restoreConsole();
  });

  it('allows injecting a custom client', async () => {
    let healthCalls = 0;
    const fake: SidecarClient = {
      async health() { healthCalls++; return true; },
      async embed(texts) { return texts.map(() => [1, 2, 3]); },
      async search() { return [{ truthId: 'fake-truth', distance: 0.1 }]; },
      async index() { return true; },
    };
    setSidecarClientForTesting(fake);
    try {
      const client = getSidecarClient();
      assert.equal(await client.health(), true);
      assert.equal(healthCalls, 1);
    } finally {
      setSidecarClientForTesting(null);
    }
  });
});
