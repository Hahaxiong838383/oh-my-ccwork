import cron, { ScheduledTask } from "node-cron";

export class SchedulerService {
  private task: ScheduledTask | null = null;
  private running = false;

  start(cronExpression: string, job: () => Promise<void>): void {
    this.stop();
    this.task = cron.schedule(cronExpression, () => {
      if (this.running) {
        console.warn("[Scheduler] skipped overlapping run");
        return;
      }
      this.running = true;
      job().catch((error) => {
        console.error("[Scheduler] job execution failed", error);
      }).finally(() => {
        this.running = false;
      });
    });
    this.task.start();
    console.log(`[Scheduler] started with cron: ${cronExpression}`);
  }

  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
      console.log("[Scheduler] stopped");
    }
  }
}
