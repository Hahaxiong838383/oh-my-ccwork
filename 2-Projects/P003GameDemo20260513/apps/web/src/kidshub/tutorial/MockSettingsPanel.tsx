import React, { useRef, useState } from 'react';
import { useTutorialStore } from './tutorial-store';
import type { TutorialTarget } from './tutorial-types';
import { FingerPointer } from './FingerPointer';

/**
 * MockSettingsPanel — 模拟设置面板（5 控件 1:1 还原）
 * - panelOpen 时由父级渲染，从顶部滑入（内部轻动画）
 * - activeTarget 用于高亮当前等待控件 + 右下角渲染小手（零测量）
 * - 每个控件外层加 data-tutorial-target 便于潜在 overlay 查询
 * - 亮度/音量：自定义竖向可拖滑条，操作即触发 advance（幂等）
 * - 常规模式：conic-gradient 彩虹环 + 3 档横条（任一点击切）
 * - 像距：纯哑控件（橙数字）
 * - 开灯/关灯：灯泡整卡可点，根据当前 lightOn 决定发 light-off / light-on
 * - close-panel：面板底部上滑热区 + 允许整体向上拖动关闭
 * - 底部 home indicator 白色横杠
 */
export function MockSettingsPanel({ activeTarget }: { activeTarget: TutorialTarget | null }) {
  const lightOn = useTutorialStore((s) => s.lightOn);
  const advanceOnAction = useTutorialStore((s) => s.advanceOnAction);

  // 面板内滑入动画（父级条件渲染后触发）
  const [entered, setEntered] = useState(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => setEntered(true), 12);
    return () => window.clearTimeout(t);
  }, []);

  // 亮度/音量 本地视觉值（仅演示拖动反馈，不持久）
  const [brightPct, setBrightPct] = useState(62);
  const [volPct, setVolPct] = useState(48);
  const dragRef = useRef<{ id: string; startY: number; fired: boolean } | null>(null);

  const fire = (t: TutorialTarget) => {
    advanceOnAction(t);
  };

  // 通用竖滑条（pointer 拖拽，视觉 + 触发 action）
  const VerticalSlider = ({
    pct,
    setPct,
    target,
    icon,
  }: {
    pct: number;
    setPct: (n: number) => void;
    target: 'brightness' | 'volume';
    icon: React.ReactNode;
  }) => {
    const trackRef = React.useRef<HTMLDivElement>(null);

    const updateFromClientY = (clientY: number, doFire: boolean) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      let ratio = (rect.bottom - clientY) / rect.height;
      ratio = Math.max(0.05, Math.min(0.95, ratio));
      const next = Math.round(ratio * 100);
      setPct(next);
      if (doFire) fire(target);
    };

    const onPointerDown = (e: React.PointerEvent) => {
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      dragRef.current = { id: target, startY: e.clientY, fired: false };
      updateFromClientY(e.clientY, true);
    };
    const onPointerMove = (e: React.PointerEvent) => {
      if (!dragRef.current || dragRef.current.id !== target) return;
      updateFromClientY(e.clientY, !dragRef.current.fired);
      if (!dragRef.current.fired) dragRef.current.fired = true;
    };
    const onPointerUp = () => {
      if (dragRef.current?.id === target) {
        dragRef.current = null;
      }
    };

    return (
      <div className="flex flex-col items-center">
        <div className="mb-[0.3cqh] text-[1.15cqw] opacity-70">{icon}</div>
        <div
          ref={trackRef}
          className="relative h-[13.5cqh] w-[1.65cqw] rounded-full bg-neutral-700 active:bg-neutral-600 cursor-pointer"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          {/* 填充 */}
          <div
            className="absolute bottom-0 left-0 right-0 rounded-full bg-gradient-to-t from-yellow-400 to-amber-300"
            style={{ height: `${pct}%` }}
          />
          {/* 拇指 */}
          <div
            className="absolute left-1/2 -translate-x-1/2 w-[2.4cqw] h-[2.4cqw] rounded-full bg-white shadow ring-1 ring-black/30 flex items-center justify-center"
            style={{ bottom: `calc(${pct}% - 1.2cqw)` }}
          >
            <div className="w-[0.9cqw] h-[0.9cqw] rounded-full bg-neutral-800" />
          </div>
        </div>
      </div>
    );
  };

  // 灯泡卡目标（随 lightOn 切换）
  const bulbTarget: TutorialTarget = lightOn ? 'light-off' : 'light-on';
  const isBulbActive = activeTarget === bulbTarget;

  // 面板整体向上拖支持（close-panel 热区）
  const panelRef = useRef<HTMLDivElement>(null);
  const closeDragRef = useRef<{ startY: number; fired: boolean } | null>(null);

  const onPanelPointerDown = (e: React.PointerEvent) => {
    if (activeTarget !== 'close-panel') return;
    closeDragRef.current = { startY: e.clientY, fired: false };
  };
  const onPanelPointerMove = (e: React.PointerEvent) => {
    const d = closeDragRef.current;
    if (!d || activeTarget !== 'close-panel') return;
    const delta = d.startY - e.clientY; // 向上为正
    if (delta > 26 && !d.fired) {
      d.fired = true;
      fire('close-panel');
    }
  };
  const onPanelPointerUp = () => {
    closeDragRef.current = null;
  };

  // 底部上滑热区点击
  const onCloseHot = () => fire('close-panel');

  return (
    <div
      ref={panelRef}
      className={`absolute top-0 left-0 right-0 z-[65] bg-neutral-900/95 backdrop-blur-md border-b border-white/10 rounded-b-3xl overflow-hidden transition-transform duration-300 ease-out ${entered ? 'translate-y-0' : '-translate-y-[82%]'} `}
      style={{ height: '54cqh' }}
      onPointerDown={onPanelPointerDown}
      onPointerMove={onPanelPointerMove}
      onPointerUp={onPanelPointerUp}
      onPointerCancel={onPanelPointerUp}
    >
      {/* 左上哑按钮：检测更新 */}
      <div className="absolute top-[0.7cqh] left-[2.2cqw] text-[1.25cqw] px-[1.4cqw] py-[0.25cqh] rounded-full bg-neutral-800/70 text-white/50 tracking-wider select-none">
        检测更新
      </div>

      {/* 5 控件横排 */}
      <div className="absolute inset-x-0 top-[3.2cqh] bottom-[2.4cqh] px-[2.1cqw] flex items-stretch gap-[1.35cqw]">
        {/* 1. 亮度（纵滑条 + 台灯光锥） */}
        <div
          data-tutorial-target="brightness"
          className={`relative flex-1 flex flex-col items-center rounded-2xl bg-neutral-800/90 pt-[1.1cqh] pb-[0.9cqh] cursor-pointer active:bg-neutral-800 ${activeTarget === 'brightness' ? 'ring-2 ring-yellow-400 ring-offset-1 ring-offset-[#171717]' : ''}`}
          onClick={() => fire('brightness')}
        >
          <div className="mb-[0.35cqh] text-[1.3cqw] text-white/70">亮度</div>
          {/* 台灯光锥（梯形渐变模拟） */}
          <div className="relative w-[3.8cqw] h-[2.6cqh] mb-[0.5cqh]">
            <div
              className="absolute bottom-0 left-1/2 -translate-x-1/2"
              style={{
                width: 0,
                height: 0,
                borderLeft: '1.65cqw solid transparent',
                borderRight: '1.65cqw solid transparent',
                borderBottom: '2.65cqh solid rgba(251,191,36,0.55)',
              }}
            />
            <div
              className="absolute bottom-0 left-1/2 -translate-x-1/2"
              style={{
                width: 0,
                height: 0,
                borderLeft: '1.1cqw solid transparent',
                borderRight: '1.1cqw solid transparent',
                borderBottom: '1.9cqh solid rgba(245,158,11,0.65)',
              }}
            />
          </div>
          <VerticalSlider
            pct={brightPct}
            setPct={setBrightPct}
            target="brightness"
            icon={<span>💡</span>}
          />
          {activeTarget === 'brightness' && (
            <div className="absolute -bottom-px -right-px">
              <FingerPointer variant="tap" />
            </div>
          )}
        </div>

        {/* 2. 常规模式（色温环 + 3档） */}
        <div
          data-tutorial-target="color-temp"
          className={`relative flex-1 flex flex-col items-center rounded-2xl bg-neutral-800/90 pt-[1.1cqh] pb-[0.9cqh] cursor-pointer active:bg-neutral-800 ${activeTarget === 'color-temp' ? 'ring-2 ring-yellow-400 ring-offset-1 ring-offset-[#171717]' : ''}`}
          onClick={() => fire('color-temp')}
        >
          <div className="mb-[0.3cqh] text-[1.3cqw] text-white/70">常规模式</div>
          {/* 彩虹色温环 */}
          <div
            className="relative w-[4.6cqw] h-[4.6cqw] rounded-full"
            style={{ background: 'conic-gradient(#e11d48,#f59e0b,#eab308,#10b981,#3b82f6,#7c3aed,#e11d48)' }}
            onClick={(e) => {
              e.stopPropagation();
              fire('color-temp');
            }}
          >
            <div className="absolute inset-[0.72cqw] rounded-full bg-neutral-900" />
            <div className="absolute inset-[1.35cqw] rounded-full bg-neutral-800 ring-1 ring-white/20" />
          </div>
          {/* 三档小横条 */}
          <div className="mt-[0.55cqh] flex gap-[0.55cqw]">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className={`h-[0.55cqh] w-[1.55cqw] rounded ${i === 1 ? 'bg-amber-400' : 'bg-white/45'}`}
                onClick={(e) => {
                  e.stopPropagation();
                  fire('color-temp');
                }}
              />
            ))}
          </div>
          {activeTarget === 'color-temp' && (
            <div className="absolute -bottom-px -right-px">
              <FingerPointer variant="tap" />
            </div>
          )}
        </div>

        {/* 3. 像距（哑控件） */}
        <div
          className="flex-1 flex flex-col items-center justify-center rounded-2xl bg-neutral-800/70 pt-[1.1cqh] pb-[0.9cqh] text-white/70"
        >
          <div className="text-[1.65cqw] font-medium tracking-wider">
            ⟷ <span className="text-orange-400">99.5</span> 米
          </div>
          <div className="mt-[0.35cqh] text-[1.25cqw] opacity-60">像距</div>
        </div>

        {/* 4. 开灯（灯泡按钮 + 状态反馈） */}
        <div
          data-tutorial-target={bulbTarget}
          className={`relative flex-1 flex flex-col items-center justify-center rounded-2xl pt-[1.1cqh] pb-[0.9cqh] cursor-pointer active:bg-neutral-800 transition-colors ${lightOn ? 'bg-neutral-800/90' : 'bg-neutral-950/70'} ${isBulbActive ? 'ring-2 ring-yellow-400 ring-offset-1 ring-offset-[#171717]' : ''}`}
          onClick={() => fire(bulbTarget)}
        >
          <div
            className={`text-[3.8cqw] transition-all ${lightOn ? 'text-yellow-300 drop-shadow-[0_0_9px_#fde047]' : 'text-neutral-500 grayscale-[0.6]'}`}
          >
            💡
          </div>
          <div className="mt-[0.3cqh] text-[1.35cqw] text-white/80">{lightOn ? '开灯' : '已关灯'}</div>
          {isBulbActive && (
            <div className="absolute -bottom-px -right-px">
              <FingerPointer variant="tap" />
            </div>
          )}
        </div>

        {/* 5. 音量（纵滑条 + 扬声器） */}
        <div
          data-tutorial-target="volume"
          className={`relative flex-1 flex flex-col items-center rounded-2xl bg-neutral-800/90 pt-[1.1cqh] pb-[0.9cqh] cursor-pointer active:bg-neutral-800 ${activeTarget === 'volume' ? 'ring-2 ring-yellow-400 ring-offset-1 ring-offset-[#171717]' : ''}`}
          onClick={() => fire('volume')}
        >
          <div className="mb-[0.3cqh] text-[1.3cqw] text-white/70">音量</div>
          <VerticalSlider
            pct={volPct}
            setPct={setVolPct}
            target="volume"
            icon={<span>🔊</span>}
          />
          {activeTarget === 'volume' && (
            <div className="absolute -bottom-px -right-px">
              <FingerPointer variant="tap" />
            </div>
          )}
        </div>
      </div>

      {/* close-panel 上滑热区（面板底部可见区） */}
      {activeTarget === 'close-panel' && (
        <div
          data-tutorial-target="close-panel"
          className="absolute bottom-[3.6cqh] left-1/2 -translate-x-1/2 z-10 px-[2.8cqw] py-[0.45cqh] rounded-full bg-white/10 text-[1.25cqw] text-white/75 flex items-center gap-[0.5cqw] active:bg-white/20 select-none"
          onClick={onCloseHot}
        >
          ↑ 上滑关闭
          <FingerPointer variant="tap" />
        </div>
      )}

      {/* home indicator 白色横杠 */}
      <div className="absolute bottom-[0.55cqh] left-1/2 -translate-x-1/2 w-[17cqw] h-[0.38cqh] rounded-full bg-white/80" />
    </div>
  );
}
