import fs from "fs";
import path from "path";
import Parser from "rss-parser";
import crypto from "crypto";
import { PulseItem, SourceConfig } from "../types";

export class FetcherService {
  private readonly parser = new Parser();
  private readonly sources: SourceConfig[];

  constructor(sourceConfigPath = path.resolve(process.cwd(), "config", "sources.json")) {
    const raw = fs.readFileSync(sourceConfigPath, "utf-8");
    this.sources = JSON.parse(raw) as SourceConfig[];
  }

  async fetchAll(): Promise<PulseItem[]> {
    const allItems: PulseItem[] = [];

    for (const source of this.sources) {
      try {
        let items: PulseItem[] = [];
        if (source.type === "rss") {
          items = await this.fetchFromRss(source);
        } else if (source.type === "api") {
          items = await this.fetchFromApi(source);
        } else if (source.type === "brave") {
          items = await this.fetchFromBrave(source);
        }
        allItems.push(...items);
      } catch (error) {
        console.error(`[Fetcher] Failed source: ${source.name}`, error);
      }
    }

    return this.deduplicateAndRank(allItems);
  }

  private async fetchFromBrave(source: SourceConfig): Promise<PulseItem[]> {
    if (!source.query) {
      return [];
    }

    const apiKey = process.env.BRAVE_API_KEY;
    if (!apiKey) {
      console.error("[Fetcher] Brave API key not configured");
      return [];
    }

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(source.query)}&count=20`;
    const response = await fetch(url, {
      headers: {
        "X-Subscription-Token": apiKey,
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Brave API error: ${response.status}`);
    }

    const data = await response.json() as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
          age?: string;
        }>;
      };
    };

    const items: PulseItem[] = [];
    const results = data.web?.results ?? [];

    for (const result of results) {
      const title = result.title?.trim() ?? "Untitled";
      const url = result.url?.trim() ?? "";
      const summary = this.cleanSummary(result.description ?? "");

      if (!title || !url) continue;

      let timestamp = new Date().toISOString();
      if (result.age) {
        const parsed = this.parseAgeToTimestamp(result.age);
        if (parsed) timestamp = parsed;
      }

      items.push({
        id: this.makeId(url),
        title,
        url,
        summary,
        source: source.name,
        category: source.category,
        timestamp,
        hotScore: this.calculateHotScore(title, timestamp)
      });
    }

    return items;
  }

  private parseAgeToTimestamp(age: string): string | null {
    const now = new Date();
    const match = age.match(/(\d+)\s*(hour|day|week|month|year)s?\s*ago/i);
    if (!match) return null;

    const num = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case "hour":
      case "hours":
        now.setHours(now.getHours() - num);
        break;
      case "day":
      case "days":
        now.setDate(now.getDate() - num);
        break;
      case "week":
      case "weeks":
        now.setDate(now.getDate() - num * 7);
        break;
      case "month":
      case "months":
        now.setMonth(now.getMonth() - num);
        break;
      case "year":
      case "years":
        now.setFullYear(now.getFullYear() - num);
        break;
    }

    return now.toISOString();
  }

  private async fetchFromRss(source: SourceConfig): Promise<PulseItem[]> {
    if (!source.url) return [];
    const feed = await this.parser.parseURL(source.url);
    const items: PulseItem[] = [];

    for (const entry of feed.items) {
      const title = entry.title?.trim() ?? "Untitled";
      const url = entry.link?.trim() ?? source.url ?? "";
      const summary = this.cleanSummary(entry.contentSnippet ?? entry.content ?? "");
      const timestamp = entry.isoDate ?? entry.pubDate ?? new Date().toISOString();

      if (!this.matchKeywords(title, summary, source.keywords)) {
        continue;
      }

      items.push({
        id: this.makeId(url),
        title,
        url,
        summary,
        source: source.name,
        category: source.category,
        timestamp,
        hotScore: this.calculateHotScore(title, timestamp)
      });
    }

    return items;
  }

  private async fetchFromApi(source: SourceConfig): Promise<PulseItem[]> {
    if (!source.url) return [];
    const timeoutMs = source.timeoutMs ?? 12000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(source.url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json() as { items?: Array<Record<string, unknown>> };
      const rawItems = Array.isArray(payload.items) ? payload.items : [];
      const items: PulseItem[] = [];

      for (const entry of rawItems) {
        const title = String(entry.title ?? "Untitled").trim();
        const url = String(entry.url ?? source.url ?? "").trim();
        const summary = this.cleanSummary(String(entry.summary ?? entry.description ?? ""));
        const timestamp = String(entry.timestamp ?? entry.publishedAt ?? new Date().toISOString());

        if (!this.matchKeywords(title, summary, source.keywords)) {
          continue;
        }

        items.push({
          id: this.makeId(url),
          title,
          url,
          summary,
          source: source.name,
          category: source.category,
          timestamp,
          hotScore: this.calculateHotScore(title, timestamp)
        });
      }

      return items;
    } finally {
      clearTimeout(timer);
    }
  }

  private makeId(input: string): string {
    return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
  }

  private cleanSummary(text: string): string {
    return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 280);
  }

  private matchKeywords(title: string, summary: string, keywords?: string[]): boolean {
    if (!keywords || keywords.length === 0) {
      return true;
    }

    const haystack = `${title} ${summary}`.toLowerCase();
    return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
  }

  private calculateHotScore(title: string, timestamp: string): number {
    const ageHours = Math.max(
      1,
      (Date.now() - new Date(timestamp).getTime()) / (1000 * 60 * 60)
    );
    const titleBoost = Math.min(20, Math.floor(title.length / 8));
    const recencyBoost = Math.max(1, Math.floor(72 / ageHours));
    return titleBoost + recencyBoost;
  }

  private deduplicateAndRank(items: PulseItem[]): PulseItem[] {
    const map = new Map<string, PulseItem>();

    for (const item of items) {
      const key = item.url.toLowerCase();
      const current = map.get(key);
      if (!current || item.hotScore > current.hotScore) {
        map.set(key, item);
      }
    }

    return Array.from(map.values()).sort((a, b) => b.hotScore - a.hotScore);
  }
}
