import { useTutorialStore, currentStep } from './tutorial-store';
import type { TutorialTarget } from './tutorial-types';
import { GuidePointer } from './GuidePointer';

/**
 * TutorialOverlay — 半透蒙版 + open-panel 手势指引（真 PNG 箭头，川哥 2026-06-14 重构）
 * - target 非 null：全屏 bg-black/55（pe-none 不挡操作），控件自己抬 z+ring 高亮露出
 * - open-panel（面板未开）：顶部下滑箭头 + 上半屏热区（点/下滑打开面板）
 * - close-panel 指引在 MockSettingsPanel 面板内（上滑箭头），不在此重复
 */
export function TutorialOverlay(): JSX.Element {
  const stepIndex = useTutorialStore((s) => s.stepIndex);
  const panelOpen = useTutorialStore((s) => s.panelOpen);
  const advanceOnAction = useTutorialStore((s) => s.advanceOnAction);

  const step = currentStep({ unitId: 'settings', stepIndex });
  const activeTarget = (step?.target ?? null) as TutorialTarget | null;

  const showMask = !!activeTarget;
  const showSwipeDown = activeTarget === 'open-panel' && !panelOpen;

  return (
    <>
      {/* 蒙版：仅在有目标时出现，pe-none 让下方控件可点 */}
      {showMask && <div className="absolute inset-0 z-[55] bg-black/55 pointer-events-none" />}

      {/* open-panel 手势热区（上半屏）：点击/下滑都视为打开面板 */}
      {showSwipeDown && (
        <div
          className="absolute top-0 left-0 right-0 h-[40%] z-[62] cursor-pointer"
          onClick={() => advanceOnAction('open-panel')}
          onPointerDown={(e) => {
            const startY = e.clientY;
            const onMove = (ev: PointerEvent) => {
              if (ev.clientY - startY > 18) {
                cleanup();
                advanceOnAction('open-panel');
              }
            };
            const cleanup = () => {
              window.removeEventListener('pointermove', onMove);
              window.removeEventListener('pointerup', cleanup);
              window.removeEventListener('pointercancel', cleanup);
            };
            window.addEventListener('pointermove', onMove, { passive: true });
            window.addEventListener('pointerup', cleanup, { once: true });
            window.addEventListener('pointercancel', cleanup, { once: true });
          }}
        />
      )}

      {/* open-panel：箭头从顶部下滑提示（配合右上六边形设置按钮高亮） */}
      {showSwipeDown && (
        <div
          className="absolute z-[70] pointer-events-none"
          style={{ left: '50%', top: '10%', transform: 'translateX(-50%)' }}
        >
          <GuidePointer variant="swipe-down" />
        </div>
      )}
    </>
  );
}
