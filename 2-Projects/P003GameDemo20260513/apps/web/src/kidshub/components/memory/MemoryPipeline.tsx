// 记忆机制流水线(纯静态说明,无 props):对话短期 → 每 3 轮回味抽取 → 五类长期入库 → 开口前横向注入;窄栏纵向步进。
import { TYPE_META, TYPE_ORDER } from './types';

/** 普通步骤卡(①②通用外观) */
function StepCard({ no, title, desc }: { no: string; title: string; desc: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/5 px-2.5 py-2">
      <div className="text-[11px] font-medium text-neutral-200">
        {no} {title}
      </div>
      <div className="mt-0.5 text-[10px] leading-relaxed text-neutral-500">{desc}</div>
    </div>
  );
}

/** 步骤间向下小箭头 */
function DownArrow() {
  return <div className="text-center text-[11px] leading-none text-neutral-600">↓</div>;
}

export function MemoryPipeline() {
  return (
    <div className="flex flex-col gap-1.5 p-3">
      <StepCard no="①" title="对话中" desc="短期记忆·上下文窗口,聊完淡出" />
      <DownArrow />
      <StepCard no="②" title="回味" desc="每 3 轮自动抽取,挑值得记的" />
      <DownArrow />

      {/* ③ 记忆库(长期):五类横向 wrap 小徽章,每类带 分类学 + 生命周期 */}
      <div className="rounded-md border border-white/10 bg-white/5 px-2.5 py-2">
        <div className="text-[11px] font-medium text-neutral-200">③ 记忆库(长期)</div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {TYPE_ORDER.map((key) => {
            const meta = TYPE_META[key];
            return (
              <span key={key} className={`inline-flex flex-col rounded px-1.5 py-1 ${meta.badgeCls}`}>
                <span className="text-[10px] font-medium leading-tight">
                  {meta.emoji} {meta.label}
                </span>
                <span className="text-[9px] leading-tight opacity-75">
                  {meta.taxonomy}·{meta.lifecycle}
                </span>
              </span>
            );
          })}
        </div>
      </div>
      <DownArrow />

      {/* ④ 装进脑中:emerald 强调框(横向调用) */}
      <div className="rounded-md border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-2">
        <div className="text-[11px] font-medium text-emerald-200">④ 装进脑中</div>
        <div className="mt-0.5 text-[10px] leading-relaxed text-emerald-300/80">
          开口前跨类型横向调用,约定优先注入
        </div>
      </div>

      {/* 记忆分类学一行说明 */}
      <div className="mt-1 text-[10px] leading-relaxed text-neutral-500">
        情景记忆 = 发生过的事(约定/事件/情绪);语义记忆 = 关于孩子的事实(偏好/关系)
      </div>
    </div>
  );
}
