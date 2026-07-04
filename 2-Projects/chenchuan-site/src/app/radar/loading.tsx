// /radar 路由级骨架屏：点击导航立即渲染，服务端数据就绪后无缝替换。
// 结构对齐 page.tsx（Pipeline 头部 + 资讯列表），避免替换时布局跳动。
export default function RadarLoading() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 pb-24 pt-28 md:px-10" aria-busy="true">
      {/* Pipeline 头部占位 */}
      <div className="animate-pulse">
        <div className="h-4 w-40 rounded bg-bg-secondary" />
        <div className="mt-4 h-9 w-72 rounded bg-bg-secondary md:w-96" />
        <div className="mt-3 h-4 w-56 rounded bg-bg-secondary" />
        <div className="mt-8 flex gap-3">
          <div className="h-8 w-24 rounded-full bg-bg-secondary" />
          <div className="h-8 w-24 rounded-full bg-bg-secondary" />
          <div className="h-8 w-24 rounded-full bg-bg-secondary" />
        </div>
      </div>

      {/* 资讯列表占位 */}
      <div className="mt-12 animate-pulse space-y-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="rounded-2xl border border-border bg-bg-secondary/50 p-5">
            <div className="h-5 w-3/4 rounded bg-bg-secondary" />
            <div className="mt-3 h-4 w-full rounded bg-bg-secondary" />
            <div className="mt-2 h-4 w-2/3 rounded bg-bg-secondary" />
            <div className="mt-4 flex gap-4">
              <div className="h-3 w-20 rounded bg-bg-secondary" />
              <div className="h-3 w-24 rounded bg-bg-secondary" />
            </div>
          </div>
        ))}
      </div>

      <p className="mt-10 text-center text-sm text-text-secondary">雷达信号接收中…</p>
    </div>
  )
}
