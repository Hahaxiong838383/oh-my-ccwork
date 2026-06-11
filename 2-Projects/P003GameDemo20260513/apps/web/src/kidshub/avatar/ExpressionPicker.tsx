import { EXPRESSIONS, expressionUrl } from './expressions';
import { useAvatarStore } from './avatar-store';
import { useKidsHubStore } from '../store/kidshub-store';

/**
 * 表情库面板 —— PM 验美术 / 调 prompt 用：点任意表情直接驱动画布里的小可。
 * 标「AI」角标的 = 在 LLM 可选菜单里（addendum 的表情清单），其余是系统态/互动专用。
 */
export function ExpressionPicker({ onClose }: { onClose: () => void }) {
  const setExpression = useAvatarStore((s) => s.setExpression);
  const currentId = useAvatarStore((s) => s.expressionId);
  const pushDebug = useKidsHubStore((s) => s.pushDebug);

  const apply = (id: string, label: string) => {
    setExpression(id, 'click');
    pushDebug({ kind: 'avatar', title: `🎭 表情库预览 → ${label}` });
  };

  return (
    <div className="absolute left-3 top-full z-30 mt-2 w-[420px] max-w-[90vw] rounded-xl border border-white/10 bg-neutral-900/95 p-3 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-medium text-neutral-300">
          小可表情库（{EXPRESSIONS.length}）· 点击直接预览
        </div>
        <button
          onClick={onClose}
          className="rounded px-2 py-0.5 text-xs text-neutral-500 hover:bg-white/10 hover:text-neutral-300"
        >
          收起
        </button>
      </div>
      <div className="grid max-h-[300px] grid-cols-5 gap-2 overflow-y-auto pr-1">
        {EXPRESSIONS.map((e) => (
          <button
            key={e.id}
            onClick={() => apply(e.id, e.label)}
            title={`${e.label} · ${e.hint}${e.llmPick ? '（LLM 可选）' : '（系统态）'}`}
            className={`group relative flex flex-col items-center rounded-lg border p-1.5 transition ${
              currentId === e.id
                ? 'border-sky-400/60 bg-sky-400/10'
                : 'border-white/5 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.08]'
            }`}
          >
            <img
              src={expressionUrl(e.files[0])}
              alt={e.label}
              loading="lazy"
              draggable={false}
              className="h-12 w-12 object-contain"
            />
            <div className="mt-1 w-full truncate text-center text-[10px] leading-tight text-neutral-400 group-hover:text-neutral-200">
              {e.label}
            </div>
            {e.llmPick && (
              <span className="absolute right-0.5 top-0.5 rounded bg-violet-500/30 px-1 text-[8px] text-violet-200">
                AI
              </span>
            )}
            {e.files.length > 1 && (
              <span className="absolute left-0.5 top-0.5 rounded bg-white/10 px-1 text-[8px] text-neutral-400">
                ×{e.files.length}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="mt-2 text-[10px] leading-relaxed text-neutral-500">
        「AI」= 小可回复时可自选的表情（见右栏附加规则菜单）；无角标 = 状态机/互动专用。点画布里的小可本体也会随机触发开心反应。
      </div>
    </div>
  );
}
