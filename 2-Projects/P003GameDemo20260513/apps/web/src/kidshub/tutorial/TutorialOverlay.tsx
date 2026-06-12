import { useTutorialStore, currentStep } from './tutorial-store';
import type { TutorialTarget } from './tutorial-types';
import { FingerPointer } from './FingerPointer';

/**
 * TutorialOverlay — 半透蒙版 + 目标高亮提示 + 画布级小手
 * - target 非 null 时全屏 bg-black/55（pointer-events-none，不挡操作）
 * - 由各控件自己抬 z + ring-yellow-400 实现"高亮露出"
 * - open-panel（面板未开）：上半区 swipe-down 小手 + 右上设置按钮由 CanvasContent 高亮
 * - close-panel：画布下半区 swipe-up 小手
 * - 同时提供 open-panel 手势热区（上半屏点击/点即视为下滑）
 */
export function TutorialOverlay(): JSX.Element {
  const stepIndex = useTutorialStore((s) => s.stepIndex);
  const panelOpen = useTutorialStore((s) => s.panelOpen);
  const advanceOnAction = useTutorialStore((s) => s.advanceOnAction);

  // 蒙版/小手只用于单元1 面板教学
  const step = currentStep({ unitId: 'settings', stepIndex });
  const activeTarget = (step?.target ?? null) as TutorialTarget | null;

  const showMask = !!activeTarget;
  const showSwipeDown = activeTarget === 'open-panel' && !panelOpen;
  const showSwipeUp = activeTarget === 'close-panel' && panelOpen;

  return (
    <>
      {/* 蒙版：仅在有目标时出现，pe-none 让下方控件可点 */}
      {showMask && (
        <div
          className="absolute inset-0 z-[55] bg-black/55 pointer-events-none"
        />
      )}

      {/* open-panel 手势热区（上半屏）：点击等同下滑/打开面板 */}
      {showSwipeDown && (
        <div
          className="absolute top-0 left-0 right-0 h-[40%] z-[62] cursor-pointer"
          onClick={() => advanceOnAction('open-panel')}
          onPointerDown={(e) => {
            // 简单向下拖动判定（孩子滑动更自然）
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

      {/* swipe-down 小手（画布中上部，偏右配合右上设置按钮） */}
      {showSwipeDown && (
        <div
          className="absolute z-[70] pointer-events-none"
          style={{ left: '58%', top: '17%' }}
        >
          <FingerPointer variant="swipe-down" />
        </div>
      )}

      {/* close-panel：画布下半区 swipe-up 小手（面板下方可见区，提示上滑） */}
      {showSwipeUp && (
        <div
          className="absolute z-[68] pointer-events-none"
          style={{ left: '50%', bottom: '24%', transform: 'translateX(-50%)' }}
        >
          <FingerPointer variant="swipe-up" />
        </div>
      )}
    </>
  );
}
