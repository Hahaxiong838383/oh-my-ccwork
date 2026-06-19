import { useAppStore } from '../../store/app-store';
import { getSharedTypewriter, type SubtitleTypewriter } from './typewriter';

/**
 * 字幕打字机单例的取用入口（cb 直连 app-store 静态方法，不依赖组件生命周期）。
 *
 * 必须放在非组件文件里：之前 export 在 CanvasHost.tsx 时，vite Fast Refresh 因
 * "组件文件导出非组件" 整链 invalidate（console 实锤），HMR 模块图撕裂直接白屏。
 */
export function sharedTypewriter(): SubtitleTypewriter {
  return getSharedTypewriter({
    // 累积语义：committed(已说·灰) + active(当前句·亮) → 富文本字幕，治逐分句整句替换的视觉跳动
    onText: (committed, active) => useAppStore.getState().setSubtitleRich({ committed, active }),
    onClear: () => useAppStore.getState().setSubtitleRich(null),
  });
}
