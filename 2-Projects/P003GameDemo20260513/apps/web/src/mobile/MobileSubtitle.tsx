import { useAppStore } from '../store/app-store';

/**
 * 移动端字幕 —— 上方小灰字=用户说的（ASR 转写，看识别准不准）；下方大字=小可说的。
 * 苹果清新：无卡片、纯文字 + 留白，大字号适配孩子，opacity 过渡不重挂（高频更新）。
 */
export function MobileSubtitle() {
  const subtitle = useAppStore((s) => s.subtitle);
  const userSubtitle = useAppStore((s) => s.userSubtitle);
  return (
    <div className="flex min-h-[5.5rem] flex-col items-center justify-center gap-1 px-6 pb-1">
      <p
        className="max-w-[32ch] text-center text-[0.95rem] font-normal leading-snug tracking-tight text-slate-400 transition-opacity duration-200"
        style={{ opacity: userSubtitle ? 1 : 0 }}
      >
        {userSubtitle ? `你：${userSubtitle}` : ' '}
      </p>
      <p
        className="max-w-[32ch] text-center text-[1.4rem] font-medium leading-snug tracking-tight text-slate-700 transition-opacity duration-200"
        style={{ opacity: subtitle ? 1 : 0 }}
      >
        {subtitle || ' '}
      </p>
    </div>
  );
}
