import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { z, ZodError } from "zod";

export const K_PROVIDER_CONFIG_PATH = "config/providers.yaml";
export const K_PROVIDER_SCHEMA_VERSION = "1";
export const K_ROUTER_DEFAULT_TIMEOUT_MS = 2500;
export const K_PROVIDER_DEFAULT_PRIORITY = 100;
export const K_PROVIDER_ID_REGEX = "^[a-z0-9][a-z0-9-_]{2,63}$";

const SLOT_VALUES = ["chat", "extract", "embed", "vision", "tool_use"] as const;
const KIND_VALUES = ["openai", "anthropic", "google", "local", "custom"] as const;
const IO_VALUES = ["text", "json", "image", "embedding", "any"] as const;

export type SlotName = (typeof SLOT_VALUES)[number];
export type ProviderKind = (typeof KIND_VALUES)[number];
export type HealthState = "unknown" | "healthy" | "degraded" | "unhealthy";

const SlotIoSchema = z.enum(IO_VALUES);
const SlotNameSchema = z.enum(SLOT_VALUES);
const ProviderKindSchema = z.enum(KIND_VALUES);

const SlotCapabilitySchema = z
  .object({
    enabled: z.boolean().default(false),
    input: SlotIoSchema.default("any"),
    output: SlotIoSchema.default("any"),
    max_input_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
  })
  .strict();

const CostSchema = z
  .object({
    input_per_1k: z.number().nonnegative(),
    output_per_1k: z.number().nonnegative(),
    currency: z.string().min(1).default("USD"),
  })
  .strict();

export const ProviderConfigSchema = z
  .object({
    id: z.string().regex(new RegExp(K_PROVIDER_ID_REGEX), "provider.id 非法"),
    kind: ProviderKindSchema,
    enabled: z.boolean().default(true),
    priority: z.number().int().min(0).max(10_000).default(K_PROVIDER_DEFAULT_PRIORITY),
    capabilities: z
      .object({
        chat: SlotCapabilitySchema.default({ enabled: false, input: "any", output: "any" }),
        extract: SlotCapabilitySchema.default({ enabled: false, input: "any", output: "any" }),
        embed: SlotCapabilitySchema.default({ enabled: false, input: "any", output: "any" }),
        vision: SlotCapabilitySchema.default({ enabled: false, input: "any", output: "any" }),
        tool_use: SlotCapabilitySchema.default({ enabled: false, input: "any", output: "any" }),
      })
      .strict(),
    models: z.array(z.string().min(1)).min(1),
    cost: CostSchema,
    latency_p95: z.number().positive(),
    auth_env: z.array(z.string().min(1)).min(1),
    timeout_ms: z.number().int().positive().default(K_ROUTER_DEFAULT_TIMEOUT_MS),
    tags: z.array(z.string().min(1)).default([]),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

const ProvidersYamlSchema = z
  .object({
    version: z.string().default(K_PROVIDER_SCHEMA_VERSION),
    providers: z.array(ProviderConfigSchema).default([]),
  })
  .strict();

export type ProviderHealth = {
  state: HealthState;
  lastCheckedAt: string;
  latencyMs?: number;
  error?: string;
};

export type ProbeResult = {
  ok: boolean;
  latencyMs?: number;
  message?: string;
};

export type ProbeFn = (provider: ProviderConfig, signal: AbortSignal) => Promise<ProbeResult>;

export type RegistryOptions = {
  probeFn?: ProbeFn;
  probeTimeoutMs?: number;
  now?: () => number;
};

export class RegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

export class ProviderValidationError extends RegistryError {
  issues: ZodError["issues"];
  constructor(error: ZodError) {
    super(`Provider 配置校验失败: ${error.issues.map((x) => x.message).join("; ")}`);
    this.issues = error.issues;
  }
}

export class DuplicateProviderError extends RegistryError {
  constructor(id: string) {
    super(`重复 provider.id: ${id}`);
  }
}

export class YamlConfigError extends RegistryError {}
export class ProviderNotFoundError extends RegistryError {}

function toIso(ts: number): string {
  return new Date(ts).toISOString();
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

function sameConfig(a: ProviderConfig, b: ProviderConfig): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function cloneDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneDeep(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cloneDeep(v)]),
    ) as T;
  }
  return value;
}

function freezeDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return Object.freeze(value);
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
    return Object.freeze(value);
  }
  return value;
}

function frozenCopy<T>(value: T): T {
  return freezeDeep(cloneDeep(value));
}

function timeoutError(ms: number): Error {
  const err = new Error(`provider_probe_timeout:${ms}`);
  err.name = "ProbeTimeoutError";
  return err;
}

async function defaultProbe(_provider: ProviderConfig, _signal: AbortSignal): Promise<ProbeResult> {
  return { ok: true };
}

export class Registry {
  private readonly providers = new Map<string, ProviderConfig>();
  private readonly healthMap = new Map<string, ProviderHealth>();
  private readonly probeFn: ProbeFn;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: RegistryOptions = {}) {
    this.probeFn = options.probeFn ?? defaultProbe;
    this.probeTimeoutMs = options.probeTimeoutMs ?? K_ROUTER_DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async register(input: unknown): Promise<ProviderConfig> {
    const parsed = ProviderConfigSchema.safeParse(input);
    if (!parsed.success) throw new ProviderValidationError(parsed.error);

    const cfg = frozenCopy(parsed.data);
    const existing = this.providers.get(cfg.id);
    if (existing) {
      if (sameConfig(existing, cfg)) return frozenCopy(existing); // 幂等注册
      throw new DuplicateProviderError(cfg.id);
    }

    this.providers.set(cfg.id, cfg);
    this.healthMap.set(cfg.id, { state: "unknown", lastCheckedAt: toIso(this.now()) });
    await this.probe(cfg.id); // 启动即 ping 一次
    return frozenCopy(cfg);
  }

  async unregister(id: string): Promise<boolean> {
    this.healthMap.delete(id);
    return this.providers.delete(id); // 不存在时返回 false，静默通过
  }

  list(): ProviderConfig[] {
    return [...this.providers.values()]
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map((cfg) => frozenCopy(cfg));
  }

  get(id: string): ProviderConfig | undefined {
    const cfg = this.providers.get(id);
    return cfg ? frozenCopy(cfg) : undefined;
  }

  health(id?: string): ProviderHealth | Record<string, ProviderHealth> | undefined {
    if (id) return this.healthMap.get(id);
    return Object.fromEntries([...this.healthMap.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  async loadFromYaml(filePath = K_PROVIDER_CONFIG_PATH): Promise<ProviderConfig[]> {
    const abs = resolve(process.cwd(), filePath);
    let raw = "";
    try {
      raw = await readFile(abs, "utf8");
    } catch (err) {
      throw new YamlConfigError(`读取 providers.yaml 失败: ${abs}`, { cause: err as Error });
    }

    let doc: unknown;
    try {
      doc = yaml.load(raw);
    } catch (err) {
      throw new YamlConfigError(`YAML 解析失败: ${abs}`, { cause: err as Error });
    }

    const parsed = ProvidersYamlSchema.safeParse(doc ?? {});
    if (!parsed.success) throw new ProviderValidationError(parsed.error);
    if (parsed.data.version !== K_PROVIDER_SCHEMA_VERSION) {
      throw new YamlConfigError(
        `schema version 不匹配: expected=${K_PROVIDER_SCHEMA_VERSION}, actual=${parsed.data.version}`,
      );
    }

    const localIds = new Set<string>();
    for (const p of parsed.data.providers) {
      if (localIds.has(p.id)) throw new DuplicateProviderError(p.id);
      localIds.add(p.id);
    }

    const candidates = parsed.data.providers.map((cfg) => frozenCopy(cfg));
    for (const cfg of candidates) {
      const existing = this.providers.get(cfg.id);
      if (!existing) continue;
      if (!sameConfig(existing, cfg)) throw new DuplicateProviderError(cfg.id);
    }

    const loaded: ProviderConfig[] = [];
    for (const cfg of candidates) {
      loaded.push(await this.register(cfg));
    }
    return loaded;
  }

  async probe(id: string): Promise<ProviderHealth> {
    const provider = this.providers.get(id);
    if (!provider) throw new ProviderNotFoundError(`provider 不存在: ${id}`);

    const started = this.now();
    try {
      const result = await this.withTimeout(
        (signal) => this.probeFn(provider, signal),
        provider.timeout_ms ?? this.probeTimeoutMs,
      );

      const latency = result.latencyMs ?? Math.max(this.now() - started, 0);
      const state: HealthState = result.ok ? "healthy" : "degraded";
      const health: ProviderHealth = {
        state,
        latencyMs: latency,
        error: result.ok ? undefined : result.message ?? "probe_failed",
        lastCheckedAt: toIso(this.now()),
      };
      if (this.providers.get(id) === provider) this.healthMap.set(id, health);
      return health;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "probe_exception";
      const degraded: ProviderHealth = {
        state: "degraded",
        latencyMs: Math.max(this.now() - started, 0),
        error: msg.includes("provider_probe_timeout") ? "probe_timeout" : msg,
        lastCheckedAt: toIso(this.now()),
      };
      if (this.providers.get(id) === provider) this.healthMap.set(id, degraded);
      return degraded;
    }
  }

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timeoutError(timeoutMs));
      }, timeoutMs);
    });

    try {
      return await Promise.race([fn(controller.signal), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
