import { useEffect, useRef } from 'react';
import { mountEcosystem, unmountEcosystem } from '../../game/ecosystem';
import { TopBar } from '../../ui/TopBar';
import { XiaokePanel } from '../../ui/XiaokePanel';
import { FocusControl } from '../../ui/FocusControl';
import { NewbieHalo } from '../../ui/NewbieHalo';

/**
 * 主界面 (Main Scene)
 *
 * 9 层堆叠（参考 docs/01-tech-architecture.md §四）：
 *   0  生态缸背景    Pixi
 *   10 环境物件       Pixi
 *   20 小可+光环      Pixi
 *   30 弱特效         Pixi
 *   40 普通模式 UI    React 层（双货币胶囊/设置/WiFi）
 *   50 动态反馈       React 层（toast/卡片，按需挂载）
 *   70 遮罩           按需
 *   80 模态           按需
 */
export function MainScene() {
  const canvasHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    void mountEcosystem(host);
    return () => unmountEcosystem();
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-screen-bg">
      {/* z=0 Pixi canvas（含 0/10/20/30/60 层，由 LayerManager 内部管理） */}
      <div ref={canvasHostRef} className="absolute inset-0 z-layer-bg" />

      {/* z=40 普通模式静态 UI */}
      <div className="absolute inset-x-0 top-0 z-layer-ui-normal">
        <TopBar />
      </div>

      {/* z=20 角色面板（DOM 层占位，M2 切到 Pixi 真渲染） */}
      <div className="pointer-events-none absolute inset-0 z-layer-char flex items-end justify-center pb-16">
        <NewbieHalo>
          <XiaokePanel />
        </NewbieHalo>
      </div>

      {/* z=40 底部操作 */}
      <div className="absolute inset-x-0 bottom-0 z-layer-ui-normal px-8 pb-4">
        <FocusControl />
      </div>
    </div>
  );
}
