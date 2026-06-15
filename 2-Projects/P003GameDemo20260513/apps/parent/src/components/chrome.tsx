// 小程序外壳共享组件：状态栏 + 流程页导航栏（带返回箭头）
// 抽自 App.tsx，供主界面与配网/建档流程页复用。

export function StatusBar() {
  return (
    <div className="flex h-9 items-center justify-between px-7 text-xs font-semibold text-text-main">
      <span>9:41</span>
      <div className="flex items-center gap-1.5">
        <span className="flex items-end gap-0.5">
          <i className="h-1.5 w-1 rounded-sm bg-text-main" />
          <i className="h-2 w-1 rounded-sm bg-text-main" />
          <i className="h-2.5 w-1 rounded-sm bg-text-main" />
          <i className="h-3 w-1 rounded-sm bg-text-main" />
        </span>
        <span className="text-[11px]">⌁</span>
        <span className="relative h-3 w-6 rounded-[4px] border border-text-main">
          <i className="absolute -right-1 top-1 h-1.5 w-0.5 rounded-r bg-text-main" />
          <i className="absolute left-0.5 top-0.5 h-2 w-4 rounded-sm bg-text-main" />
        </span>
      </div>
    </div>
  );
}

// 流程页导航栏：左侧返回 ‹，居中标题（可空），右侧微信胶囊 ··· ⊙
export function FlowNav({ title, onBack }: { title?: string; onBack: () => void }) {
  return (
    <header className="sticky top-0 z-20 bg-page-bg/95 pb-2 backdrop-blur">
      <StatusBar />
      <div className="relative flex h-11 items-center justify-center px-4">
        <button
          className="absolute left-2 grid h-8 w-8 place-items-center text-3xl leading-none text-text-main"
          onClick={onBack}
          type="button"
          aria-label="返回"
        >
          ‹
        </button>
        {title ? <h1 className="text-base font-semibold text-text-main">{title}</h1> : null}
        <div className="absolute right-4 flex h-8 w-[86px] items-center justify-around rounded-full bg-black/5 text-lg text-text-main">
          <span className="tracking-[-2px]">···</span>
          <span className="text-base">⊙</span>
        </div>
      </div>
    </header>
  );
}
