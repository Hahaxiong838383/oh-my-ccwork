import { useExperienceStore } from '../store/experience-store';

/**
 * 体验限额转化漏斗 UI（仅公开模式渲染，由 StudioPage gate）：
 *  - ExperienceHintBar：峰值轻提示条（非阻断，体验到爽点时顶部出现）
 *  - ExperienceLeadModal：超限弹窗（B 端话术 + 微信二维码 + 软退路）
 *
 * 文案面向 HR / 投资人（评估陈川的人），不是儿童产品的家长——故走"聊实现/
 * 要文档/探讨合作"的专业引导，而非"加微信继续体验"的 to C 话术。
 */

// 二维码走 BASE_URL 前缀（公开版 base=/kidshub-ai/ → /kidshub-ai/kidshub/wechat-qr.png）
const QR_SRC = `${import.meta.env.BASE_URL}kidshub/wechat-qr.png`;

export function ExperienceHintBar() {
  const shouldShow = useExperienceStore((s) => s.shouldShowHint());
  const dismissHint = useExperienceStore((s) => s.dismissHint);
  const openModal = useExperienceStore((s) => s.openModal);

  if (!shouldShow) return null;

  return (
    <div className="flex items-center justify-center gap-3 border-b border-emerald-500/20 bg-emerald-500/10 px-4 py-1.5 text-xs text-emerald-200">
      <span>🚀 玩得挺深入。想聊聊小可背后的实时语音架构、要产品文档？</span>
      <button
        onClick={openModal}
        className="rounded-full border border-emerald-400/50 px-2.5 py-0.5 font-medium text-emerald-100 hover:bg-emerald-400/20"
      >
        加我微信 →
      </button>
      <button
        onClick={dismissHint}
        className="text-emerald-300/60 hover:text-emerald-200"
        aria-label="关闭提示"
      >
        ✕
      </button>
    </div>
  );
}

export function ExperienceLeadModal() {
  const open = useExperienceStore((s) => s.modalOpen);
  const closeModal = useExperienceStore((s) => s.closeModal);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={closeModal}
    >
      <div
        className="relative w-full max-w-md rounded-2xl border border-white/10 bg-neutral-900 p-7 text-center shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={closeModal}
          className="absolute right-4 top-4 text-neutral-500 hover:text-neutral-300"
          aria-label="关闭"
        >
          ✕
        </button>

        <div className="mb-2 text-lg font-semibold text-white">看来你对小可挺感兴趣 👀</div>
        <p className="mx-auto mb-5 max-w-sm text-sm leading-relaxed text-neutral-300">
          你已经把小可的场景和对话都体验过一轮了。它背后的实时语音链路（ASR→LLM→TTS
          全流式）、表情驱动、儿童对话安全设计，我很乐意展开聊。想要完整产品文档、深聊实现细节，或探讨合作
          —— 扫码加我微信。
        </p>

        <div className="mx-auto mb-2 w-44 rounded-xl bg-white p-2">
          <img src={QR_SRC} alt="陈川的微信二维码" className="h-full w-full rounded-lg" />
        </div>
        <div className="mb-5 text-xs text-emerald-300">扫码加陈川微信</div>

        <button
          onClick={closeModal}
          className="text-xs text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline"
        >
          再看看小可
        </button>
      </div>
    </div>
  );
}
