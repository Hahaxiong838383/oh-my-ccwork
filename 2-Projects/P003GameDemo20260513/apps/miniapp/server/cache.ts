type CacheEntry<T> = { value: T; expiresAt: number };

export class TtlCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly now: () => number = Date.now) {}

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number) {
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  deleteByPrefix(prefix: string) {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }
}
