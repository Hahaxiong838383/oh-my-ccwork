export function TaskRouterCard() {
  return (
    <a
      href="/work/task-router"
      className="mb-5 grid items-center gap-3 rounded-xl border border-border bg-white p-[18px] text-text-primary hover:border-accent/50 md:grid-cols-[27%_1fr] md:gap-7"
    >
      <img src="/task-router/cover.webp" alt="任务路由工作台设计稿" loading="lazy" decoding="async" width={400} height={356} className="h-[138px] w-full rounded-lg object-cover object-[center_33%] md:h-[156px]" />
      <div>
        <small className="text-text-secondary">组织协作 · AI 工作助手</small>
        <h3 className="my-1 text-2xl font-semibold">任务路由引擎</h3>
        <p>用 Jev 辅助判断任务归属，用 BRO-PDCA 把目标、约束和验收标准交给承接人及其 AI 助手。</p>
        <span className="font-semibold text-accent">查看项目设计 →</span>
      </div>
    </a>
  )
}
