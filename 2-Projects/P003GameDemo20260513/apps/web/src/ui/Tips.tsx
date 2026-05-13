import { AnimatePresence, motion } from 'framer-motion';
import { useFeedbackQueue } from '../store/feedback-queue';

/**
 * 通用 Tips（z=50 动态反馈层，来自 3.13）
 *
 * 屏幕中央，自下而上浮入 → 停 1s → 自下而上浮出消失。
 * 单一来源：通过 `useFeedbackQueue.getState().pushTip(text)` 触发。
 * 队列规则在 store 里实现，本组件只负责渲染。
 */
const SHORT_THRESHOLD = 10; // ≤10 字 一行

export function Tips() {
  const queue = useFeedbackQueue((s) => s.queue);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/2 z-layer-feedback flex -translate-y-1/2 flex-col items-center gap-2">
      <AnimatePresence>
        {queue.map((item) => {
          const isShort = item.text.length <= SHORT_THRESHOLD;
          return (
            <motion.div
              key={item.id}
              initial={{ y: 30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -30, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className={`rounded-full bg-black/70 px-4 py-2 backdrop-blur-md ring-1 ring-white/10 ${
                isShort ? 'text-sm' : 'text-xs leading-relaxed max-w-[280px] text-center'
              }`}
            >
              {item.text}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
