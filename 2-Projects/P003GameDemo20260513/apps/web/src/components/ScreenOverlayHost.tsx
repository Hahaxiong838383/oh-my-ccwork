import type { ReactNode } from 'react';

interface ScreenOverlayHostProps {
  children?: ReactNode;
}

/**
 * ScreenOverlayHost —— 画内 Modal 唯一挂载点
 *
 * codex 评审强建议：所有画内弹层（配网引导/倒计时环/设置面板/二次确认）
 * 必须挂到屏幕 relative 根内，禁止 position:fixed、禁止 portal 到 document.body。
 * rotate(90deg) 旋转后 fixed 元素坐标错乱、点击热区漂移。
 *
 * 使用方式：在 MainScreen 中调用 <ScreenOverlayHost>{overlays}</ScreenOverlayHost>。
 * 层级：z-mask=70 / z-modal=80（与 tailwind z-layer 对齐）。
 */
export function ScreenOverlayHost({ children }: ScreenOverlayHostProps) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-layer-feedback"
      data-overlay-host
    >
      {children}
    </div>
  );
}
