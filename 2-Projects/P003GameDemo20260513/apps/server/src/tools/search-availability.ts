/** Process-local upstream protection. Ledger quotas persist separately across restarts. */
export class SearchAvailability {
  private until = 0;
  private errors = 0;
  private reason: string | null = null;
  constructor(private now = Date.now) {}
  available() {
    if (this.until && this.now() >= this.until) { this.until = 0; this.errors = 0; this.reason = null; }
    return this.until === 0;
  }
  state() { return { available: this.available(), retry_at: this.until || null, reason: this.reason }; }
  success() { this.errors = 0; }
  failure(code: string) {
    let delay = 0;
    if (code === 'upstream_402') delay = 300_000;
    else if (code === 'upstream_429') delay = 30_000;
    else if (/^upstream_5\d\d$/.test(code) && ++this.errors >= 3) delay = 30_000;
    if (delay) { this.until = Math.max(this.until, this.now() + delay); this.reason = code; }
  }
}
