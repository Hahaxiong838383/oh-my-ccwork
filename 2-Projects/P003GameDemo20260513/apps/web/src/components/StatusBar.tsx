import { AnimatePresence, motion } from 'framer-motion';
import { useAppStore } from '../store/app-store';

interface StatusBarProps {}

export function StatusBar(_props: StatusBarProps) {
  const subtitle = useAppStore((s) => s.subtitle);
  const voiceStatus = useAppStore((s) => s.voiceStatus);

  const visible = subtitle.trim().length > 0 || voiceStatus !== 'idle';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          // framer-motion 的 animate.y 会 inline transform 覆盖 tailwind -translate-x-1/2，
          // 必须把 x: '-50%' 也写进 motion 的 keyframes，否则字幕容器溢出画布右边。
          initial={{ opacity: 0, y: 12, x: '-50%' }}
          animate={{ opacity: 1, y: 0, x: '-50%' }}
          exit={{ opacity: 0, y: 12, x: '-50%' }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="pointer-events-none absolute bottom-24 left-1/2 z-layer-feedback w-[92%] max-w-[620px]"
        >
          <div className="rounded-2xl bg-black/55 px-4 py-2 text-center text-sm text-white backdrop-blur-sm ring-1 ring-white/10">
            {subtitle || '...'}
          </div>

          <div className="mt-2 flex h-5 items-center justify-center text-xs text-white/90">
            {voiceStatus === 'listening' && (
              <div className="flex items-center gap-1.5 text-blue-200">
                <span className="h-2 w-2 rounded-full bg-blue-300 animate-pulse" />
                <span>・小可正在听...</span>
              </div>
            )}

            {voiceStatus === 'thinking' && (
              <div className="flex items-center gap-1.5 text-yellow-200">
                <span>・小可在想...</span>
                <span className="flex items-end gap-1">
                  {[0, 1, 2].map((item) => (
                    <span
                      key={`thinking-dot-${item}`}
                      className="h-1.5 w-1.5 rounded-full bg-yellow-200"
                      style={{ animation: `status-thinking 0.9s ease-in-out ${item * 0.16}s infinite` }}
                    />
                  ))}
                </span>
              </div>
            )}

            {voiceStatus === 'speaking' && (
              <div className="flex items-center gap-1.5 text-emerald-200">
                <span>・小可正在说</span>
                <span className="flex h-3 items-end gap-0.5">
                  {[0, 1, 2].map((item) => (
                    <span
                      key={`speaking-wave-${item}`}
                      className="w-1 rounded-full bg-emerald-300"
                      style={{ animation: `status-speaking-wave 0.8s ease-in-out ${item * 0.1}s infinite` }}
                    />
                  ))}
                </span>
              </div>
            )}
          </div>

          <style>{`
            @keyframes status-thinking {
              0%, 100% {
                transform: translateY(0);
                opacity: 0.35;
              }
              50% {
                transform: translateY(-3px);
                opacity: 1;
              }
            }

            @keyframes status-speaking-wave {
              0%, 100% {
                height: 4px;
                opacity: 0.6;
              }
              50% {
                height: 10px;
                opacity: 1;
              }
            }
          `}</style>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
