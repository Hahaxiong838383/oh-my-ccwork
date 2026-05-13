import { AnimatePresence, motion } from 'framer-motion';

/**
 * 通用二级确认弹窗（z=80 模态层，来自 3.13）
 *
 * 布局规则（产品文档约束）：
 * - 正文 ≤12 字单行；12-24 字两行字号变小；>24 字截断
 * - 按钮**优先 2 字**（保排版美观），3-4 字需重出美术，>4 字截断
 * - 屏幕中央 + 半透明遮罩
 *
 * V1.0 demo 强制使用场景：
 * - 退出专注二次确认（来自 1.3 §二）
 * - 购买皮肤确认（来自 1.8 §2.3）
 * - 设置项变更确认（按需）
 */

const LONG_TEXT_THRESHOLD = 12;

export interface ConfirmModalProps {
  open: boolean;
  body: string;
  confirmText?: string; // 默认 "确认"，建议 2 字
  cancelText?: string;  // 默认 "取消"
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  body,
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const truncated = body.length > 24 ? `${body.slice(0, 24)}…` : body;
  const isLong = truncated.length > LONG_TEXT_THRESHOLD;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 z-layer-modal flex items-center justify-center bg-black/40 backdrop-blur-sm"
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            className="flex w-[260px] flex-col items-center gap-3 rounded-2xl border border-white/10 bg-shell-frame px-4 py-4 shadow-2xl"
          >
            <div className={`text-center ${isLong ? 'text-xs leading-relaxed' : 'text-sm'}`}>
              {truncated}
            </div>
            <div className="flex gap-2">
              <button
                onClick={onCancel}
                className="rounded-full bg-white/10 px-4 py-1.5 text-xs text-white/80 active:scale-95"
              >
                {truncate4(cancelText)}
              </button>
              <button
                onClick={onConfirm}
                className="rounded-full bg-porthole-glow px-4 py-1.5 text-xs text-screen-bg active:scale-95"
              >
                {truncate4(confirmText)}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function truncate4(s: string): string {
  return s.length > 4 ? s.slice(0, 4) : s;
}
