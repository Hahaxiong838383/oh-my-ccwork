import { useKidsHubStore } from '../store/kidshub-store';
import { findUnfilledPlaceholders } from '../prompts';

interface PromptPreviewModalProps {
  open: boolean;
  onClose: () => void;
}

export function PromptPreviewModal({ open, onClose }: PromptPreviewModalProps) {
  const getComposed = useKidsHubStore((s) => s.getComposedPrompt);

  if (!open) return null;

  const composed = getComposed();
  const chars = composed.length;
  const unfilled = findUnfilledPlaceholders(composed);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(composed);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = composed;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-[820px] overflow-hidden rounded-2xl border border-white/10 bg-neutral-900 text-sm shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
          <div>
            <span className="font-medium text-white">组装后完整 System Prompt</span>
            <span className="ml-3 text-xs text-neutral-500">共 {chars} 字符</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={copy}
              className="rounded bg-white/10 px-3 py-1 text-xs text-white hover:bg-white/15 active:bg-white/20"
            >
              复制全文
            </button>
            <button onClick={onClose} className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-white/5">
              关闭
            </button>
          </div>
        </div>

        {unfilled.length > 0 && (
          <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-300">
            ⚠ 检测到未填充占位符：{unfilled.join(', ')}（请检查变量表）
          </div>
        )}

        <div className="max-h-[62vh] overflow-auto bg-neutral-950 p-4">
          <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-neutral-200">
            {composed || '(空)'}
          </pre>
        </div>

        <div className="border-t border-white/10 px-4 py-2 text-[10px] text-neutral-500">
          此文本即 sendSessionConfig 实际下发内容。debug.prompt_assembled 也会回传 server 收到的版本。
        </div>
      </div>
    </div>
  );
}
