export type SourceType = "rss" | "api" | "brave";

export interface SourceConfig {
  name: string;
  type: SourceType;
  url?: string;
  query?: string;
  category: string;
  keywords?: string[];
  timeoutMs?: number;
}

export interface PulseItem {
  id: string;
  title: string;
  url: string;
  summary: string;
  source: string;
  category: string;
  timestamp: string;
  hotScore: number;
}

export interface PushResult {
  channel: "email" | "feishu";
  success: boolean;
  message?: string;
}

export interface DailyReport {
  date: string;
  items: PulseItem[];
}

export interface AppConfig {
  cronExpression: string;
  topN: number;
  channels: Array<"email" | "feishu">;
}
