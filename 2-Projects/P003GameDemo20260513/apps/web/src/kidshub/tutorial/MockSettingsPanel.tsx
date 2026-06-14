import React, { useRef, useState } from 'react';
import { useTutorialStore } from './tutorial-store';
import type { TutorialTarget } from './tutorial-types';
import { GuidePointer, GuideRing } from './GuidePointer';

/**
 * MockSettingsPanel — 读写台设备设置面板（川哥 2026-06-14 一比一还原设计图 设置界面.png）
 *
 * 4 控件（与设计图严格对齐，无开关灯）：
 *  - 亮度/音量：竖向滑块（细灰轨道+填充+大白圆滑块头+图标+拖动浮百分比气泡）
 *  - 光谱模式：彩虹圆盘（环+暗心，无中心图标）+ 4段选择器，默认「暖光」高亮
 *  - 像距：侧视示意图（侧脸+虚线+蓝屏幕随拖动前后移）+ 横滑块 2.5~10 米
 *  - 重置：顶栏「恢复初始」；护耳：音量 >85% 变红
 *  - 指引：真 PNG 小手/箭头/光圈
 * 交互契约：data-tutorial-target + advanceOnAction(target)。开关灯已从引导移除（设计图无）。
 * 注：VSlider 提到模块级（不在 render 内联定义），避免父 setState 时 remount 中断拖拽。
 */

interface LightMode {
  name: string;
  icon: string;
  ring: string;
}
const LIGHT_MODES: LightMode[] = [
  { name: '常规', icon: '☀️', ring: 'conic-gradient(from 210deg,#22d3ee,#3b82f6,#a855f7,#22d3ee)' },
  { name: '暖光', icon: '🛋️', ring: 'conic-gradient(from 200deg,#f59e0b,#fbbf24,#fb923c,#f59e0b)' },
  { name: '绘画', icon: '🎨', ring: 'conic-gradient(from 200deg,#38bdf8,#3b82f6,#818cf8,#38bdf8)' },
  { name: '夜读', icon: '🌙', ring: 'conic-gradient(from 210deg,#fb923c,#f59e0b,#fdba74,#fb923c)' },
];

const DEFAULTS = { bright: 64, vol: 78, mode: 1, dist: 5.5 };
const DIST_MIN = 2.5;
const DIST_MAX = 10;
const VOL_SAFE = 85;

function aring(on: boolean): string {
  return on ? 'ring-2 ring-amber-400/90 ring-offset-1 ring-offset-[#15171c]' : 'ring-1 ring-white/10';
}

/** 竖向滑块（亮度/音量共用，模块级组件，避免 remount） */
function VSlider({
  target,
  value,
  setValue,
  icon,
  fill,
  label,
  red,
  activeTarget,
  dragRef,
  fire,
}: {
  target: TutorialTarget;
  value: number;
  setValue: (n: number) => void;
  icon: string;
  fill: string;
  label: string;
  red?: boolean;
  activeTarget: TutorialTarget | null;
  dragRef: React.MutableRefObject<string | null>;
  fire: (t: TutorialTarget) => void;
}) {
  const apply = (clientY: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (r.bottom - clientY) / r.height));
    setValue(Math.round(ratio * 100));
  };
  const headBorder = red ? 'border-red-400' : target === 'brightness' ? 'border-amber-300' : 'border-sky-300';
  return (
    <div className={`flex flex-[1] flex-col items-center rounded-[1.6cqw] bg-[#26252b]/80 px-[1cqw] py-[1.4cqh] ${aring(activeTarget === target)}`}>
      <div className="mb-[1cqh] text-[2.2cqw]">{icon}</div>
      <div
        data-tutorial-target={target}
        className="relative flex-1 cursor-pointer touch-none"
        style={{ width: '5cqw' }}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          dragRef.current = target;
          apply(e.clientY, e.currentTarget as HTMLElement);
          fire(target);
        }}
        onPointerMove={(e) => {
          if (dragRef.current !== target) return;
          apply(e.clientY, e.currentTarget as HTMLElement);
        }}
        onPointerUp={() => {
          if (dragRef.current === target) dragRef.current = null;
        }}
      >
        <div className="absolute left-1/2 top-0 h-full w-[1.7cqw] -translate-x-1/2 overflow-hidden rounded-full bg-white/12">
          <div className="absolute inset-x-0 bottom-0 rounded-full" style={{ height: `${value}%`, background: fill }} />
        </div>
        <div
          className={`absolute left-1/2 h-[3.6cqw] w-[3.6cqw] -translate-x-1/2 translate-y-1/2 rounded-full border-[0.4cqw] bg-white shadow-[0_1px_6px_rgba(0,0,0,0.45)] ${headBorder}`}
          style={{ bottom: `calc(${value}% - 1.8cqw)` }}
        />
        <div className="absolute left-[4cqw] -translate-y-1/2 rounded-md bg-black/60 px-[0.9cqw] py-[0.2cqh] text-[1.35cqw] font-medium text-white" style={{ bottom: `calc(${value}% - 0.9cqw)` }}>
          {value}%
        </div>
        {activeTarget === target && <GuideRing />}
        {activeTarget === target && (
          <div className="absolute -right-[5.5cqw] top-1/2 -translate-y-1/2">
            <GuidePointer variant="tap" />
          </div>
        )}
      </div>
      <div className="mt-[1cqh] text-[1.5cqw] text-white/85">
        {label}
        {red && <span className="ml-[0.4cqw] text-[1.1cqw] text-red-400">护耳</span>}
      </div>
    </div>
  );
}

export function MockSettingsPanel({ activeTarget }: { activeTarget: TutorialTarget | null }) {
  const advanceOnAction = useTutorialStore((s) => s.advanceOnAction);
  const fire = (t: TutorialTarget) => advanceOnAction(t);

  const [entered, setEntered] = useState(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => setEntered(true), 12);
    return () => window.clearTimeout(t);
  }, []);

  const [bright, setBright] = useState(DEFAULTS.bright);
  const [vol, setVol] = useState(DEFAULTS.vol);
  const [modeIdx, setModeIdx] = useState(DEFAULTS.mode);
  const [dist, setDist] = useState(DEFAULTS.dist);
  const dragRef = useRef<string | null>(null);

  const reset = () => {
    setBright(DEFAULTS.bright);
    setVol(DEFAULTS.vol);
    setModeIdx(DEFAULTS.mode);
    setDist(DEFAULTS.dist);
  };

  const applyDist = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    setDist(Math.round((DIST_MIN + ratio * (DIST_MAX - DIST_MIN)) * 10) / 10);
  };

  const distRatio = (dist - DIST_MIN) / (DIST_MAX - DIST_MIN);
  const volRed = vol > VOL_SAFE;

  const closeRef = useRef<{ startY: number; fired: boolean } | null>(null);
  const onPanelDown = (e: React.PointerEvent) => {
    if (activeTarget !== 'close-panel') return;
    closeRef.current = { startY: e.clientY, fired: false };
  };
  const onPanelMove = (e: React.PointerEvent) => {
    const d = closeRef.current;
    if (!d || activeTarget !== 'close-panel') return;
    if (d.startY - e.clientY > 26 && !d.fired) {
      d.fired = true;
      fire('close-panel');
    }
  };
  const onPanelUp = () => {
    closeRef.current = null;
  };

  return (
    <div
      className={`absolute top-0 left-0 right-0 z-[65] overflow-hidden rounded-b-3xl border-b border-white/10 backdrop-blur-xl transition-transform duration-300 ease-out ${entered ? 'translate-y-0' : '-translate-y-[82%]'}`}
      style={{
        height: '100cqh',
        background: 'radial-gradient(120% 85% at 50% 6%, rgba(38,40,54,0.94), rgba(26,28,40,0.96) 55%, rgba(16,17,26,0.98))',
      }}
      onPointerDown={onPanelDown}
      onPointerMove={onPanelMove}
      onPointerUp={onPanelUp}
      onPointerCancel={onPanelUp}
    >
      {/* 顶栏 */}
      <div className="absolute left-[2.6cqw] top-[2.8cqh] select-none rounded-full border border-white/15 bg-white/5 px-[1.7cqw] py-[0.5cqh] text-[1.4cqw] tracking-wide text-emerald-300/80">
        ⟳ 检测更新
      </div>
      <div className="absolute right-[2.6cqw] top-[3cqh] flex items-center gap-[1.3cqw]">
        <svg viewBox="0 0 24 18" className="h-[1.9cqh]" fill="none">
          <path d="M2 6.5C8 1.5 16 1.5 22 6.5M5 10C9 6.5 15 6.5 19 10M8 13.5c2.4-2 5.6-2 8 0" stroke="white" strokeOpacity="0.75" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="12" cy="16" r="1.3" fill="white" fillOpacity="0.85" />
        </svg>
        <button type="button" onClick={reset} className="flex items-center gap-[0.4cqw] rounded-full border border-white/15 bg-white/5 px-[1.4cqw] py-[0.45cqh] text-[1.3cqw] text-white/65 transition active:scale-95 hover:bg-white/10">
          ↺ 恢复初始
        </button>
      </div>

      {/* 控件区 */}
      <div className="absolute inset-x-0 top-[13cqh] bottom-[9cqh] flex items-stretch gap-[1.6cqw] px-[2.6cqw]">
        <VSlider target="brightness" value={bright} setValue={setBright} icon="☀️" fill="linear-gradient(to top,#f59e0b,#fcd34d)" label="亮度" activeTarget={activeTarget} dragRef={dragRef} fire={fire} />
        <VSlider target="volume" value={vol} setValue={setVol} icon={vol < 6 ? '🔇' : '🔊'} fill={volRed ? 'linear-gradient(to top,#dc2626,#f87171)' : 'linear-gradient(to top,#0ea5e9,#7dd3fc)'} label="音量" red={volRed} activeTarget={activeTarget} dragRef={dragRef} fire={fire} />

        {/* 光谱模式 */}
        <div data-tutorial-target="color-temp" className={`relative flex flex-[1.7] flex-col items-center rounded-[1.6cqw] bg-[#26252b]/80 p-[1cqw] ${aring(activeTarget === 'color-temp')}`}>
          <div className="relative mt-[0.6cqh] h-[8.5cqh] w-[8.5cqh] shrink-0 rounded-full" style={{ background: 'conic-gradient(from 90deg,#ef4444,#f97316,#eab308,#22c55e,#3b82f6,#a855f7,#ef4444)' }}>
            <div className="absolute inset-[0.55cqh] rounded-full bg-[#15171c] shadow-[inset_0_0_8px_rgba(0,0,0,0.7)]" />
          </div>
          <div className="mt-[1.1cqh] grid w-full grid-cols-2 gap-[0.7cqw]">
            {LIGHT_MODES.map((m, i) => (
              <button
                key={m.name}
                type="button"
                onClick={() => {
                  setModeIdx(i);
                  fire('color-temp');
                }}
                className={`flex items-center justify-center gap-[0.4cqw] rounded-[0.9cqw] py-[0.9cqh] text-[1.4cqw] transition active:scale-95 ${
                  i === modeIdx ? 'bg-amber-400/90 font-medium text-neutral-900 shadow-[0_2px_8px_rgba(245,158,11,0.4)]' : 'bg-white/8 text-white/70 hover:bg-white/14'
                }`}
              >
                <span>{m.icon}</span>
                {m.name}
              </button>
            ))}
          </div>
          <div className="mt-[0.9cqh] text-[1.5cqw] text-white/85">光谱模式</div>
          {activeTarget === 'color-temp' && (
            <div className="absolute bottom-[1cqh] right-[1cqw]">
              <GuidePointer variant="tap" />
            </div>
          )}
        </div>

        {/* 像距 */}
        <div className="flex flex-[1.5] flex-col items-center justify-center rounded-[1.6cqw] bg-[#26252b]/80 p-[1.2cqw]">
          <div className="relative mb-[0.5cqh] h-[8cqh] w-full">
            <svg viewBox="0 0 34 38" className="absolute left-[4%] top-1/2 h-[6.5cqh] -translate-y-1/2" fill="none">
              <path d="M22 3c5 0 8 5 8 12 0 4-1 7-3 9l1 5c0 3-3 6-8 6-7 0-13-6-13-15S13 3 22 3Z" fill="#f1c9a5" stroke="#d9a878" strokeWidth="1" />
              <circle cx="24" cy="15" r="1.6" fill="#3a2c22" />
              <path d="M30 17c2 1 3 2 2 3l-2 1" stroke="#d9a878" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <div className="absolute left-[26%] right-[8%] top-1/2 h-px -translate-y-1/2 border-t border-dashed border-white/30" />
            <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 transition-[left] duration-100" style={{ left: `${26 + distRatio * 60}%` }}>
              <svg viewBox="0 0 22 32" className="h-[6cqh]" fill="none">
                <rect x="3" y="2" width="16" height="28" rx="2.5" fill="#38bdf8" fillOpacity="0.2" stroke="#7dd3fc" strokeWidth="1.6" />
                <rect x="6" y="6" width="10" height="16" rx="1" fill="#7dd3fc" fillOpacity="0.4" />
              </svg>
            </div>
          </div>
          <div className="text-[3cqw] font-semibold text-amber-400">
            {dist.toFixed(1)} <span className="text-[1.5cqw] text-white/70">米</span>
          </div>
          <div
            className="relative mt-[0.6cqh] h-[3.4cqh] w-[88%] cursor-pointer touch-none"
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              dragRef.current = 'dist';
              applyDist(e.clientX, e.currentTarget as HTMLElement);
            }}
            onPointerMove={(e) => {
              if (dragRef.current !== 'dist') return;
              applyDist(e.clientX, e.currentTarget as HTMLElement);
            }}
            onPointerUp={() => {
              if (dragRef.current === 'dist') dragRef.current = null;
            }}
          >
            <div className="absolute left-0 right-0 top-1/2 h-[1cqh] -translate-y-1/2 overflow-hidden rounded-full bg-white/12">
              <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-teal-400 to-amber-400" style={{ width: `${distRatio * 100}%` }} />
            </div>
            <div className="absolute top-1/2 h-[3.2cqw] w-[3.2cqw] -translate-x-1/2 -translate-y-1/2 rounded-full border-[0.35cqw] border-white bg-sky-400 shadow-[0_1px_4px_rgba(0,0,0,0.4)]" style={{ left: `${distRatio * 100}%` }} />
          </div>
          <div className="mt-[0.3cqh] flex w-[88%] justify-between text-[1.1cqw] text-white/40">
            <span>2.5米 近</span>
            <span>远 10米</span>
          </div>
          <div className="mt-[0.5cqh] text-[1.5cqw] text-white/85">像距</div>
        </div>
      </div>

      {/* close-panel 上滑热区 */}
      {activeTarget === 'close-panel' && (
        <div data-tutorial-target="close-panel" className="absolute bottom-[3.2cqh] left-1/2 z-10 flex -translate-x-1/2 select-none flex-col items-center gap-[0.3cqh] active:scale-95" onClick={() => fire('close-panel')}>
          <GuidePointer variant="swipe-up" />
          <span className="rounded-full bg-white/10 px-[2.2cqw] py-[0.4cqh] text-[1.2cqw] text-white/75">上滑关闭</span>
        </div>
      )}

      {/* home indicator */}
      <div className="absolute bottom-[2.4cqh] left-1/2 h-[0.5cqh] w-[16cqw] -translate-x-1/2 rounded-full bg-white/70" />
    </div>
  );
}
