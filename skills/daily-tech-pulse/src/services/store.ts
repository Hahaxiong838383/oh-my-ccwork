import fs from "fs";
import path from "path";
import { PulseItem } from "../types";

interface StoreData {
  items: PulseItem[];
  lastRunAt?: string;
}

export class DataStore {
  private readonly filePath: string;

  constructor(filePath = path.resolve(process.cwd(), "data", "store.json")) {
    this.filePath = filePath;
    this.ensureFile();
  }

  private ensureFile(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ items: [] }, null, 2), "utf-8");
    }
  }

  private readRaw(): StoreData {
    const content = fs.readFileSync(this.filePath, "utf-8");
    return JSON.parse(content) as StoreData;
  }

  private writeRaw(data: StoreData): void {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  getItems(): PulseItem[] {
    return this.readRaw().items;
  }

  saveItems(items: PulseItem[]): void {
    this.writeRaw({ items, lastRunAt: new Date().toISOString() });
  }

  upsertItems(items: PulseItem[]): PulseItem[] {
    const existing = this.getItems();
    const map = new Map<string, PulseItem>();

    for (const item of existing) {
      map.set(item.id, item);
    }

    for (const item of items) {
      map.set(item.id, item);
    }

    const merged = Array.from(map.values()).sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    this.saveItems(merged);
    return merged;
  }
}
