import React, { useRef, useState } from 'react';
import { useTutorialStore } from './tutorial-store';
import type { TutorialTarget } from './tutorial-types';
import { GuidePointer, GuideRing } from './GuidePointer';

/**
 * MockSettingsPanel — 读写台设备设置面板（川哥 2026-06-14 二次还原：image2 3D 素材 + 玻璃质感）
 *
 * 设计图 设置面板UI方案v1.png 一比一还原要点：
 *  - 背景：image2 生成的深色科幻 HUD 面板底图（settings-ui/panel-bg.png），替换原纯色渐变
 *  - 卡片：深蓝玻璃 + 青色发光边框（非灰色实心矩形）
 *  - 图标：emoji 套 3D 玻璃圆底座（非裸 emoji）
 *  - 像距：image2 生成的 3D 儿童侧脸（settings-ui/child-profile.png，深蓝底 + radial-mask 羽化），
 *         替换原 SVG「一坨椭圆」；蓝屏幕随滑块前后移（保留 SVG 以便交互联动）
 *  - 顶栏：补绿色齿轮设置按钮（设计图右上）
 * 交互契约不变：data-tutorial-target + advanceOnAction(target)。VSlider 保持模块级避免 remount。
 */

const DEFAULTS = { bright: 64, vol: 78, mode: 1, dist: 5.5 };
const DIST_MIN = 2.5;
const DIST_MAX = 10;
const VOL_SAFE = 85;

const LIGHT_MODES = [
  { name: '常规', icon: '☀️' },
  { name: '暖光', icon: '🛋️' },
  { name: '绘画', icon: '🎨' },
  { name: '夜读', icon: '🌙' },
];

/** 控件卡片外壳：深蓝玻璃 + 青色发光边框（设计图的独立发光玻璃块感）；active 时琥珀高亮 */
function cardClass(active: boolean): string {
  return [
    'relative flex flex-col items-center rounded-[1.8cqw] border-[0.18cqw] backdrop-blur-md transition',
    'bg-gradient-to-b from-[#0e2342]/55 to-[#081124]/65',
    active
      ? 'border-amber-300/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_0_24px_rgba(245,158,11,0.5)]'
      : 'border-cyan-300/45 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_22px_rgba(56,189,248,0.08),0_4px_16px_rgba(0,0,0,0.5),0_0_16px_rgba(56,189,248,0.18)]',
  ].join(' ');
}

/** emoji 3D 玻璃圆底座 */
function IconBadge({ icon }: { icon: string }) {
  return (
    <div className="flex h-[4.4cqw] w-[4.4cqw] items-center justify-center rounded-full bg-white/8 text-[2.4cqw] shadow-[inset_0_1px_2px_rgba(255,255,255,0.18),0_2px_6px_rgba(0,0,0,0.3)] ring-1 ring-white/12">
      {icon}
    </div>
  );
}

/** 竖向滑块（亮度/音量共用，模块级组件，避免 remount） */
function VSlider({
  target,
  value,
  setValue,
  icon,
  fill,
  glow,
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
  glow: string;
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
    <div className={`flex-[1] px-[1cqw] py-[1.5cqh] ${cardClass(activeTarget === target)}`}>
      <div className="mb-[1cqh]">
        <IconBadge icon={icon} />
      </div>
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
        {/* 轨道 */}
        <div className="absolute left-1/2 top-0 h-full w-[2.4cqw] -translate-x-1/2 overflow-hidden rounded-full bg-black/35 shadow-[inset_0_0_4px_rgba(0,0,0,0.6)]">
          <div
            className="absolute inset-x-0 bottom-0 rounded-full"
            style={{ height: `${value}%`, background: fill, boxShadow: `0 0 12px ${glow}` }}
          />
        </div>
        {/* 滑块头 */}
        <div
          className={`absolute left-1/2 h-[4cqw] w-[4cqw] -translate-x-1/2 translate-y-1/2 rounded-full border-[0.45cqw] bg-white shadow-[0_2px_8px_rgba(0,0,0,0.5)] ${headBorder}`}
          style={{ bottom: `calc(${value}% - 2cqw)`, boxShadow: `0 0 10px ${glow}, 0 2px 8px rgba(0,0,0,0.5)` }}
        />
        {/* 百分比气泡 */}
        <div
          className="absolute left-[4.4cqw] -translate-y-1/2 rounded-md bg-black/70 px-[0.9cqw] py-[0.2cqh] text-[1.4cqw] font-semibold text-white shadow-sm"
          style={{ bottom: `calc(${value}% - 0.9cqw)` }}
        >
          {value}%
        </div>
        {activeTarget === target && <GuideRing />}
        {activeTarget === target && (
          <div className="absolute -right-[5.5cqw] top-1/2 -translate-y-1/2">
            <GuidePointer variant="tap" />
          </div>
        )}
      </div>
      <div className="mt-[1cqh] text-[1.6cqw] font-medium text-white/90">
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
      className={`absolute top-0 left-0 right-0 z-[65] overflow-hidden rounded-b-3xl border-b border-cyan-300/20 transition-transform duration-300 ease-out ${entered ? 'translate-y-0' : '-translate-y-[82%]'}`}
      style={{ height: '100cqh' }}
      onPointerDown={onPanelDown}
      onPointerMove={onPanelMove}
      onPointerUp={onPanelUp}
      onPointerCancel={onPanelUp}
    >
      {/* 背景：image2 科幻 HUD 面板底图 + 兜底深蓝 */}
      <div className="absolute inset-0 -z-10 bg-[#081427]" />
      <img
        src="/kidshub/settings-ui/panel-bg.png"
        alt=""
        draggable={false}
        className="pointer-events-none absolute inset-0 -z-10 h-full w-full select-none object-cover"
      />

      {/* 顶栏 */}
      <div className="absolute left-[2.6cqw] top-[2.8cqh] z-10 select-none rounded-full border border-emerald-300/40 bg-emerald-400/10 px-[1.7cqw] py-[0.5cqh] text-[1.4cqw] tracking-wide text-emerald-300/90">
        ⟳ 检测更新
      </div>
      <div className="absolute right-[2.6cqw] top-[2.8cqh] z-10 flex items-center gap-[1.3cqw]">
        <svg viewBox="0 0 24 18" className="h-[1.9cqh]" fill="none">
          <path d="M2 6.5C8 1.5 16 1.5 22 6.5M5 10C9 6.5 15 6.5 19 10M8 13.5c2.4-2 5.6-2 8 0" stroke="white" strokeOpacity="0.75" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="12" cy="16" r="1.3" fill="white" fillOpacity="0.85" />
        </svg>
        {/* 绿色齿轮设置按钮（设计图右上） */}
        <div className="flex h-[3.4cqh] w-[3.4cqh] items-center justify-center rounded-full bg-emerald-400/15 text-[1.8cqh] text-emerald-300 ring-1 ring-emerald-300/40 shadow-[0_0_10px_rgba(16,185,129,0.35)]">
          ⚙️
        </div>
        <button type="button" onClick={reset} className="flex items-center gap-[0.4cqw] rounded-full border border-white/15 bg-white/5 px-[1.4cqw] py-[0.45cqh] text-[1.3cqw] text-white/70 transition active:scale-95 hover:bg-white/10">
          ↺ 恢复初始
        </button>
      </div>

      {/* 控件区 */}
      <div className="absolute inset-x-0 top-[13cqh] bottom-[9cqh] z-[1] flex items-stretch gap-[1.6cqw] px-[2.6cqw]">
        <VSlider target="brightness" value={bright} setValue={setBright} icon="☀️" fill="linear-gradient(to top,#f59e0b,#fcd34d)" glow="rgba(245,158,11,0.55)" label="亮度" activeTarget={activeTarget} dragRef={dragRef} fire={fire} />
        <VSlider target="volume" value={vol} setValue={setVol} icon={vol < 6 ? '🔇' : '🔊'} fill={volRed ? 'linear-gradient(to top,#dc2626,#f87171)' : 'linear-gradient(to top,#0ea5e9,#7dd3fc)'} glow={volRed ? 'rgba(220,38,38,0.55)' : 'rgba(14,165,233,0.55)'} label="音量" red={volRed} activeTarget={activeTarget} dragRef={dragRef} fire={fire} />

        {/* 光谱模式 */}
        <div data-tutorial-target="color-temp" className={`flex-[2.15] px-[1.4cqw] py-[2cqh] ${cardClass(activeTarget === 'color-temp')}`}>
          <div
            className="relative h-[11cqh] w-[11cqh] shrink-0 rounded-full shadow-[0_0_26px_rgba(168,85,247,0.5)]"
            style={{ background: 'conic-gradient(from 90deg,#ef4444,#f97316,#eab308,#22c55e,#3b82f6,#a855f7,#ef4444)' }}
          >
            <div className="absolute inset-[0.6cqh] rounded-full bg-[#0b1a30] shadow-[inset_0_0_10px_rgba(0,0,0,0.8)]" />
          </div>
          <div className="my-[1.4cqh] grid w-full flex-1 grid-cols-2 grid-rows-2 gap-[1cqw]">
            {LIGHT_MODES.map((m, i) => (
              <button
                key={m.name}
                type="button"
                onClick={() => {
                  setModeIdx(i);
                  fire('color-temp');
                }}
                className={`flex h-full items-center justify-center gap-[0.6cqw] rounded-[1.1cqw] text-[1.8cqw] transition active:scale-95 ${
                  i === modeIdx
                    ? 'bg-amber-400/90 font-semibold text-neutral-900 shadow-[0_2px_10px_rgba(245,158,11,0.5)]'
                    : 'bg-white/8 text-white/75 ring-1 ring-white/10 hover:bg-white/14'
                }`}
              >
                <span className="text-[2.2cqw]">{m.icon}</span>
                {m.name}
              </button>
            ))}
          </div>
          <div className="shrink-0 text-[1.6cqw] font-medium text-white/90">光谱模式</div>
          {activeTarget === 'color-temp' && (
            <div className="absolute bottom-[1cqh] right-[1cqw]">
              <GuidePointer variant="tap" />
            </div>
          )}
        </div>

        {/* 像距 */}
        <div className={`flex-[2.15] justify-center p-[1.2cqw] ${cardClass(false)}`}>
          <div className="relative mb-[0.5cqh] h-[8.5cqh] w-full">
            {/* 3D 儿童侧脸（image2 素材，深蓝底 + radial-mask 羽化融入卡片） */}
            <img
              src="/kidshub/settings-ui/child-profile.png"
              alt=""
              draggable={false}
              className="pointer-events-none absolute left-[5%] top-[40%] h-[26cqh] w-[13cqw] -translate-y-1/2 select-none object-cover"
              style={{
                maskImage: 'radial-gradient(ellipse 64% 72% at 50% 40%, #000 60%, transparent 84%)',
                WebkitMaskImage: 'radial-gradient(ellipse 64% 72% at 50% 40%, #000 60%, transparent 84%)',
              }}
            />
            {/* 虚线 */}
            <div className="absolute left-[30%] right-[8%] top-1/2 h-px -translate-y-1/2 border-t border-dashed border-cyan-200/40" />
            {/* 蓝色发光屏幕（随滑块前后移） */}
            <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 transition-[left] duration-100" style={{ left: `${30 + distRatio * 56}%` }}>
              <svg viewBox="0 0 22 32" className="h-[6.2cqh] drop-shadow-[0_0_8px_rgba(56,189,248,0.6)]" fill="none">
                <rect x="3" y="2" width="16" height="28" rx="2.5" fill="#38bdf8" fillOpacity="0.25" stroke="#7dd3fc" strokeWidth="1.6" />
                <rect x="6" y="6" width="10" height="16" rx="1" fill="#7dd3fc" fillOpacity="0.5" />
              </svg>
            </div>
          </div>
          <div className="text-[3.2cqw] font-bold text-amber-400 drop-shadow-[0_0_8px_rgba(245,158,11,0.35)]">
            {dist.toFixed(1)} <span className="text-[1.5cqw] font-medium text-white/70">米</span>
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
            <div className="absolute left-0 right-0 top-1/2 h-[1.1cqh] -translate-y-1/2 overflow-hidden rounded-full bg-black/35 shadow-[inset_0_0_4px_rgba(0,0,0,0.6)]">
              <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-teal-400 to-amber-400" style={{ width: `${distRatio * 100}%` }} />
            </div>
            <div className="absolute top-1/2 h-[3.4cqw] w-[3.4cqw] -translate-x-1/2 -translate-y-1/2 rounded-full border-[0.4cqw] border-white bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.6),0_1px_4px_rgba(0,0,0,0.4)]" style={{ left: `${distRatio * 100}%` }} />
          </div>
          <div className="mt-[0.3cqh] flex w-[88%] justify-between text-[1.1cqw] text-white/45">
            <span>2.5米 近</span>
            <span>远 10米</span>
          </div>
          <div className="mt-[0.5cqh] text-[1.6cqw] font-medium text-white/90">像距</div>
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
      <div className="absolute bottom-[2.4cqh] left-1/2 z-10 h-[0.5cqh] w-[16cqw] -translate-x-1/2 rounded-full bg-white/70" />
    </div>
  );
}
