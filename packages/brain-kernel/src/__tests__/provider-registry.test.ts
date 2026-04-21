import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DuplicateProviderError,
  ProviderValidationError,
  Registry,
  YamlConfigError,
} from "../providers/registry";

const baseProvider = (overrides: Record<string, unknown> = {}) => ({
  id: "openai-main",
  kind: "openai",
  capabilities: {
    chat: { enabled: true, input: "text", output: "text" },
    extract: { enabled: true, input: "text", output: "json" },
    embed: { enabled: false, input: "text", output: "embedding" },
    vision: { enabled: false, input: "image", output: "text" },
    tool_use: { enabled: true, input: "text", output: "json" },
  },
  models: ["gpt-5.4-mini"],
  cost: { input_per_1k: 0.002, output_per_1k: 0.006, currency: "USD" },
  latency_p95: 1800,
  auth_env: ["OPENAI_API_KEY"],
  ...overrides,
});

async function withTempYaml(content: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "provider-registry-"));
  const file = join(dir, "providers.yaml");
  await writeFile(file, content, "utf8");
  return { dir, file };
}

test("register/get/list 基本流程", async () => {
  const registry = new Registry();
  await registry.register(baseProvider());
  assert.equal(registry.get("openai-main")?.id, "openai-main");
  assert.equal(registry.list().length, 1);
});

test("register 幂等：同配置重复注册返回已有对象", async () => {
  const registry = new Registry();
  const first = await registry.register(baseProvider());
  const second = await registry.register(baseProvider());
  assert.equal(first.id, second.id);
  assert.equal(registry.list().length, 1);
});

test("重复 id 但配置不同应拒绝", async () => {
  const registry = new Registry();
  await registry.register(baseProvider());
  await assert.rejects(
    registry.register(baseProvider({ models: ["gpt-5.4"] })),
    DuplicateProviderError,
  );
});

test("unregister 已存在 id 成功删除", async () => {
  const registry = new Registry();
  await registry.register(baseProvider());
  assert.equal(await registry.unregister("openai-main"), true);
  assert.equal(registry.get("openai-main"), undefined);
});

test("unregister 不存在 id 静默通过", async () => {
  const registry = new Registry();
  assert.equal(await registry.unregister("not-exists"), false);
});

test("schema 校验失败应拒绝", async () => {
  const registry = new Registry();
  await assert.rejects(
    registry.register(baseProvider({ models: [] })), // 非法：models 至少一个
    ProviderValidationError,
  );
});

test("健康探测成功 -> healthy", async () => {
  const registry = new Registry({
    probeFn: async () => ({ ok: true, latencyMs: 12 }),
  });
  await registry.register(baseProvider());
  const h = registry.health("openai-main");
  assert.equal((h as any)?.state, "healthy");
  assert.equal((h as any)?.latencyMs, 12);
});

test("健康探测超时 -> degraded", async () => {
  const registry = new Registry({
    probeTimeoutMs: 10,
    probeFn: async () => new Promise(() => undefined),
  });
  await registry.register(baseProvider({ id: "slow-provider" }));
  const h = registry.health("slow-provider");
  assert.equal((h as any)?.state, "degraded");
  assert.equal((h as any)?.error, "probe_timeout");
});

test("loadFromYaml 成功加载", async () => {
  const yamlText = `
version: "1"
providers:
  - id: openai-main
    kind: openai
    capabilities:
      chat: { enabled: true, input: text, output: text }
      extract: { enabled: true, input: text, output: json }
      embed: { enabled: false, input: text, output: embedding }
      vision: { enabled: false, input: image, output: text }
      tool_use: { enabled: true, input: text, output: json }
    models: ["gpt-5.4-mini"]
    cost: { input_per_1k: 0.002, output_per_1k: 0.006, currency: USD }
    latency_p95: 1800
    auth_env: ["OPENAI_API_KEY"]
`;
  const { dir, file } = await withTempYaml(yamlText);
  const registry = new Registry();
  try {
    const loaded = await registry.loadFromYaml(file);
    assert.equal(loaded.length, 1);
    assert.equal(registry.list().length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("YAML 解析错误应抛出 YamlConfigError", async () => {
  const { dir, file } = await withTempYaml("providers: [:::broken");
  const registry = new Registry();
  try {
    await assert.rejects(registry.loadFromYaml(file), YamlConfigError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("YAML 内重复 id 应拒绝", async () => {
  const yamlText = `
version: "1"
providers:
  - id: dup-id
    kind: openai
    capabilities:
      chat: { enabled: true, input: text, output: text }
      extract: { enabled: false, input: text, output: json }
      embed: { enabled: false, input: text, output: embedding }
      vision: { enabled: false, input: image, output: text }
      tool_use: { enabled: false, input: text, output: json }
    models: ["m1"]
    cost: { input_per_1k: 0.1, output_per_1k: 0.2, currency: USD }
    latency_p95: 100
    auth_env: ["K1"]
  - id: dup-id
    kind: openai
    capabilities:
      chat: { enabled: true, input: text, output: text }
      extract: { enabled: false, input: text, output: json }
      embed: { enabled: false, input: text, output: embedding }
      vision: { enabled: false, input: image, output: text }
      tool_use: { enabled: false, input: text, output: json }
    models: ["m2"]
    cost: { input_per_1k: 0.1, output_per_1k: 0.2, currency: USD }
    latency_p95: 110
    auth_env: ["K1"]
`;
  const { dir, file } = await withTempYaml(yamlText);
  const registry = new Registry();
  try {
    await assert.rejects(registry.loadFromYaml(file), DuplicateProviderError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unregister during slow probe 不应残留幽灵 health", async () => {
  let probeCalls = 0;
  let resolveSlowProbe: ((value: { ok: boolean; latencyMs?: number }) => void) | undefined;
  const slowProbePromise = new Promise<{ ok: boolean; latencyMs?: number }>((resolve) => {
    resolveSlowProbe = resolve;
  });

  const registry = new Registry({
    probeFn: async () => {
      probeCalls += 1;
      if (probeCalls === 1) return { ok: true, latencyMs: 5 };
      return slowProbePromise;
    },
  });

  await registry.register(baseProvider({ id: "ghost-check" }));
  const probing = registry.probe("ghost-check");
  await registry.unregister("ghost-check");
  resolveSlowProbe?.({ ok: true, latencyMs: 20 });
  await probing;
  assert.equal(registry.health("ghost-check"), undefined);
});

test("外部修改 get 返回对象不影响内部配置", async () => {
  const registry = new Registry();
  await registry.register(baseProvider({ id: "immutable-check" }));

  const first = registry.get("immutable-check");
  assert.ok(first);

  assert.throws(() => {
    (first!.models as string[]).push("evil-model");
  });
  assert.throws(() => {
    (first!.capabilities.chat as { enabled: boolean }).enabled = false;
  });

  const second = registry.get("immutable-check");
  assert.ok(second);
  assert.notEqual(first, second);
  assert.deepEqual(second!.models, ["gpt-5.4-mini"]);
  assert.equal(second!.capabilities.chat.enabled, true);
});

test("loadFromYaml 中途校验失败应保持原子性", async () => {
  const yamlText = `
version: "1"
providers:
  - id: ok-provider
    kind: openai
    capabilities:
      chat: { enabled: true, input: text, output: text }
      extract: { enabled: false, input: text, output: json }
      embed: { enabled: false, input: text, output: embedding }
      vision: { enabled: false, input: image, output: text }
      tool_use: { enabled: false, input: text, output: json }
    models: ["m-ok"]
    cost: { input_per_1k: 0.1, output_per_1k: 0.2, currency: USD }
    latency_p95: 100
    auth_env: ["K1"]
  - id: bad-provider
    kind: openai
    capabilities:
      chat: { enabled: true, input: text, output: text }
      extract: { enabled: false, input: text, output: json }
      embed: { enabled: false, input: text, output: embedding }
      vision: { enabled: false, input: image, output: text }
      tool_use: { enabled: false, input: text, output: json }
    models: []
    cost: { input_per_1k: 0.1, output_per_1k: 0.2, currency: USD }
    latency_p95: 100
    auth_env: ["K1"]
`;
  const { dir, file } = await withTempYaml(yamlText);
  const registry = new Registry();
  try {
    await assert.rejects(registry.loadFromYaml(file), ProviderValidationError);
    assert.equal(registry.list().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
