import "dotenv/config";
import { FetcherService } from "./services/fetcher";
import { PusherService } from "./services/pusher";
import { SchedulerService } from "./services/scheduler";
import { DataStore } from "./services/store";
import { AppConfig } from "./types";

const config: AppConfig = {
  cronExpression: process.env.CRON_EXPRESSION ?? "0 8,14,20 * * *",
  topN: Number(process.env.TOP_N ?? "20"),
  channels: ((process.env.PUSH_CHANNELS ?? "email,feishu").split(",") as Array<"email" | "feishu">)
};

const fetcher = new FetcherService();
const pusher = new PusherService();
const scheduler = new SchedulerService();
const store = new DataStore();

async function runOnce(): Promise<void> {
  console.log("[DailyTechPulse] run start");
  const fetched = await fetcher.fetchAll();
  const merged = store.upsertItems(fetched);
  const latest = merged
    .sort((a, b) => b.hotScore - a.hotScore)
    .slice(0, config.topN);

  const results = await pusher.push(config.channels, latest);

  console.log(`[DailyTechPulse] fetched=${fetched.length} stored=${merged.length} pushed=${latest.length}`);
  for (const result of results) {
    console.log(`[DailyTechPulse] push ${result.channel} success=${result.success} message=${result.message ?? "ok"}`);
  }
}

async function main(): Promise<void> {
  await runOnce();
  scheduler.start(config.cronExpression, runOnce);
}

main().catch((error) => {
  console.error("[DailyTechPulse] fatal error", error);
  process.exit(1);
});
