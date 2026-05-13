import { useEffect, useRef } from 'react';
import { mountEcosystem, unmountEcosystem } from '../../game/ecosystem';
import { TopBar } from '../../ui/TopBar';
import { K1Panel } from '../../ui/K1Panel';
import { FocusControl } from '../../ui/FocusControl';

export function MainScene() {
  const canvasHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    mountEcosystem(host);
    return () => unmountEcosystem();
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-porthole-bg">
      {/* z-0 Pixi canvas 背景 */}
      <div ref={canvasHostRef} className="absolute inset-0" />

      {/* z-100 静态 UI */}
      <div className="absolute inset-x-0 top-0 z-10">
        <TopBar />
      </div>

      <div className="absolute inset-x-0 bottom-0 z-10 p-4 pb-8">
        <K1Panel />
        <FocusControl />
      </div>
    </div>
  );
}
