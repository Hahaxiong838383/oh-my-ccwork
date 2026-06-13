import React, { useRef, useState } from 'react';
import { useTutorialStore } from './tutorial-store';
import type { TutorialTarget } from './tutorial-types';
import { FingerPointer } from './FingerPointer';

/**
 * MockSettingsPanel — 读写台设备设置面板（严格还原真机 UI；川哥 2026-06-13 附件 4 张为准）
 *
 * 视觉 1:1 贴合真机：iOS 风暗色玻璃面板，下滑入场。4 控件区：
 *  - 亮度：整卡竖向拖动（iOS 亮度条），台灯暖光束随亮度涨落
 *  - 模式：光谱曲线圆盘，点击循环 常规→暖1→绘画→夜读；环色 / 光谱形 / 三档点 / 像距数 全联动
 *  - 像距 + 开关灯：右侧上下堆叠两卡（像距随模式变；灯泡⚡按 lightOn 开关）
 *  - 音量：最右窄条，整卡竖向拖动
 * 交互契约不变：data-tutorial-target + advanceOnAction(target) + FingerPointer 指向 activeTarget。
 */

interface LightMode {
  name: string;
  /** 像距数值（随模式变，对应真机 4 图） */
  distance: string;
  /** 圆盘外环 background（CSS 渐变或纯色） */
  ring: string;
  /** 光谱面积曲线 path（userSpace viewBox 0 0 100 64，y=64 为底边；warm 模式右侧截断少蓝光） */
  spectrum: string;
  /** 三档指示高亮位（0/1/2）与颜色 */
  dashIdx: number;
  dashColor: string;
}

/** 4 模式配表（严格对应川哥 4 张真机图：常规99.5 / 暖1 6.5 / 绘画6.5 / 夜读0.5） */
const LIGHT_MODES: LightMode[] = [
  {
    name: '常规',
    distance: '99.5',
    ring: 'conic-gradient(from 210deg, #22d3ee, #3b82f6, #a855f7, #22d3ee)',
    spectrum: 'M3,62 C19,62 27,16 50,14 C73,12 81,62 97,62 Z',
    dashIdx: 0,
    dashColor: '#38bdf8',
  },
  {
    name: '暖1',
    distance: '6.5',
    ring: 'radial-gradient(circle at 50% 38%, #fbf3da, #ece0bb)',
    spectrum: 'M6,62 C18,62 27,20 45,17 C63,14 70,62 84,62 Z',
    dashIdx: 1,
    dashColor: '#fbbf24',
  },
  {
    name: '绘画',
    distance: '6.5',
    ring: 'conic-gradient(from 200deg, #38bdf8, #3b82f6, #818cf8, #38bdf8)',
    spectrum: 'M3,62 C18,62 26,13 50,11 C74,9 82,62 97,62 Z',
    dashIdx: 1,
    dashColor: '#38bdf8',
  },
  {
    name: '夜读',
    distance: '0.5',
    ring: 'conic-gradient(from 210deg, #fb923c, #f59e0b, #fdba74, #fb923c)',
    spectrum: 'M10,62 C21,62 27,18 39,15 C51,12 57,62 67,62 Z',
    dashIdx: 2,
    dashColor: '#fb923c',
  },
];

/** 光谱曲线圆盘：外环 + 暗底 + 彩虹面积曲线 + 3 档指示 */
function SpectrumDial({ mode }: { mode: LightMode }) {
  return (
    <div className="flex flex-col items-center">
      <div className="relative h-[12cqh] w-[12cqh] rounded-full" style={{ background: mode.ring }}>
        {/* 暗底（露出环宽 ~0.62cqh） */}
        <div className="absolute inset-[0.62cqh] rounded-full bg-[#15171c] shadow-[inset_0_0_9px_rgba(0,0,0,0.7)]" />
        {/* 光谱面积曲线 */}
        <div className="absolute inset-[1.3cqh] overflow-hidden rounded-full">
          <svg viewBox="0 0 100 64" preserveAspectRatio="none" className="h-full w-full">
            <defs>
              <linearGradient id="spd-grad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0">
                <stop offset="0%" stopColor="#ef4444" />
                <stop offset="20%" stopColor="#f97316" />
                <stop offset="38%" stopColor="#eab308" />
                <stop offset="56%" stopColor="#22c55e" />
                <stop offset="76%" stopColor="#3b82f6" />
                <stop offset="100%" stopColor="#a855f7" />
              </linearGradient>
            </defs>
            <path d={mode.spectrum} fill="url(#spd-grad)" opacity="0.93" />
          </svg>
        </div>
      </div>
      {/* 3 档指示 */}
      <div className="mt-[0.75cqh] flex gap-[0.55cqw]">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-[0.52cqh] w-[1.8cqw] rounded-full"
            style={{
              background: i === mode.dashIdx ? mode.dashColor : 'rgba(255,255,255,0.22)',
              boxShadow: i === mode.dashIdx ? `0 0 5px ${mode.dashColor}` : 'none',
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** 灯泡 + 闪电 图标（开/关两态着色） */
function BulbBoltIcon({ on }: { on: boolean }) {
  const c = on ? '#fde68a' : '#6b7280';
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[5.4cqh] w-[5.4cqh]"
      style={{ filter: on ? 'drop-shadow(0 0 7px #fcd34d)' : 'none' }}
    >
      <path
        d="M12 2.5a6.5 6.5 0 0 0-4 11.6c.7.55 1.2 1.2 1.4 2H14.6c.2-.8.7-1.45 1.4-2A6.5 6.5 0 0 0 12 2.5Z"
        fill="none"
        stroke={c}
        strokeWidth="1.6"
      />
      <path d="M9.4 19.2h5.2M10 21h4" stroke={c} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12.6 6.3 9.8 11.2h2.2l-.6 3.4 3-4.9h-2.2l.4-3.4Z" fill={c} />
    </svg>
  );
}

export function MockSettingsPanel({ activeTarget }: { activeTarget: TutorialTarget | null }) {
  const lightOn = useTutorialStore((s) => s.lightOn);
  const advanceOnAction = useTutorialStore((s) => s.advanceOnAction);

  // 面板下滑入场动画
  const [entered, setEntered] = useState(false);
  React.useEffect(() => {
    const t = window.setTimeout(() => setEntered(true), 12);
    return () => window.clearTimeout(t);
  }, []);

  // 本地视觉状态（仅演示反馈，不持久）
  const [brightPct, setBrightPct] = useState(64);
  const [volPct, setVolPct] = useState(52);
  const [modeIdx, setModeIdx] = useState(0);
  const mode = LIGHT_MODES[modeIdx];

  const fire = (t: TutorialTarget) => advanceOnAction(t);

  // 整卡竖向拖动（亮度 / 音量共用）：clientY → pct（底=0 顶=100）+ 触发 target
  const dragRef = useRef<{ id: string } | null>(null);
  const makeCardDrag = (target: 'brightness' | 'volume', setPct: (n: number) => void) => {
    const apply = (clientY: number, el: HTMLElement, doFire: boolean) => {
      const rect = el.getBoundingClientRect();
      let ratio = (rect.bottom - clientY) / rect.height;
      ratio = Math.max(0.05, Math.min(1, ratio));
      setPct(Math.round(ratio * 100));
      if (doFire) fire(target);
    };
    return {
      onPointerDown: (e: React.PointerEvent) => {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        dragRef.current = { id: target };
        apply(e.clientY, e.currentTarget as HTMLElement, true);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (dragRef.current?.id !== target) return;
        apply(e.clientY, e.currentTarget as HTMLElement, false);
      },
      onPointerUp: () => {
        if (dragRef.current?.id === target) dragRef.current = null;
      },
    };
  };
  const brightDrag = makeCardDrag('brightness', setBrightPct);
  const volDrag = makeCardDrag('volume', setVolPct);

  // 模式卡点击：循环切换（视觉反馈）+ 推进 color-temp（推进幂等）
  const onModeTap = () => {
    setModeIdx((i) => (i + 1) % LIGHT_MODES.length);
    fire('color-temp');
  };

  // 灯泡卡目标随 lightOn 切换
  const bulbTarget: TutorialTarget = lightOn ? 'light-off' : 'light-on';
  const isBulbActive = activeTarget === bulbTarget;

  // 面板上滑关闭（close-panel 热区，整体拖动）
  const closeDragRef = useRef<{ startY: number; fired: boolean } | null>(null);
  const onPanelPointerDown = (e: React.PointerEvent) => {
    if (activeTarget !== 'close-panel') return;
    closeDragRef.current = { startY: e.clientY, fired: false };
  };
  const onPanelPointerMove = (e: React.PointerEvent) => {
    const d = closeDragRef.current;
    if (!d || activeTarget !== 'close-panel') return;
    if (d.startY - e.clientY > 26 && !d.fired) {
      d.fired = true;
      fire('close-panel');
    }
  };
  const onPanelPointerUp = () => {
    closeDragRef.current = null;
  };

  const ring = (active: boolean) =>
    active ? 'ring-2 ring-yellow-400 ring-offset-1 ring-offset-[#15171c]' : '';

  return (
    <div
      className={`absolute top-0 left-0 right-0 z-[65] overflow-hidden rounded-b-3xl border-b border-white/10 backdrop-blur-xl transition-transform duration-300 ease-out ${entered ? 'translate-y-0' : '-translate-y-[82%]'}`}
      style={{
        height: '100cqh',
        background:
          'radial-gradient(120% 85% at 50% 8%, rgba(82,74,80,0.92), rgba(54,50,58,0.95) 50%, rgba(32,30,38,0.97))',
      }}
      onPointerDown={onPanelPointerDown}
      onPointerMove={onPanelPointerMove}
      onPointerUp={onPanelPointerUp}
      onPointerCancel={onPanelPointerUp}
    >
      {/* 顶栏：检测更新 / WiFi + 品牌六边形 */}
      <div className="absolute left-[2.6cqw] top-[3cqh] select-none rounded-[0.9cqw] border border-white/15 bg-white/5 px-[1.6cqw] py-[0.55cqh] text-[1.45cqw] tracking-wide text-white/55">
        检测更新
      </div>
      <div className="absolute right-[2.6cqw] top-[3.3cqh] flex items-center gap-[1.2cqw]">
        <svg viewBox="0 0 24 18" className="h-[2cqh]" fill="none">
          <path
            d="M2 6.5C8 1.5 16 1.5 22 6.5M5 10C9 6.5 15 6.5 19 10M8 13.5c2.4-2 5.6-2 8 0"
            stroke="white"
            strokeOpacity="0.8"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle cx="12" cy="16" r="1.3" fill="white" fillOpacity="0.85" />
        </svg>
        <svg viewBox="0 0 24 24" className="h-[2.4cqh]" fill="none">
          <path d="M12 2.6 20.4 7.3v9.4L12 21.4 3.6 16.7V7.3Z" stroke="white" strokeOpacity="0.5" strokeWidth="1.6" />
          <path
            d="M9.4 12.2 11.2 14l3.6-3.8"
            stroke="white"
            strokeOpacity="0.8"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {/* 控件区 */}
      <div className="absolute inset-x-0 top-[15cqh] bottom-[11cqh] flex items-stretch gap-[1.5cqw] px-[2.6cqw]">
        {/* 1. 亮度（整卡拖动 + 台灯光束） */}
        <div
          data-tutorial-target="brightness"
          className={`relative flex flex-[1.05] cursor-pointer flex-col justify-end overflow-hidden rounded-[1.6cqw] bg-[#26252b]/85 ${ring(activeTarget === 'brightness')}`}
          {...brightDrag}
        >
          {/* 光束：自顶部洒下，高度 = 亮度，梯形向下扩散 */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0"
            style={{
              height: `${brightPct}%`,
              background:
                'linear-gradient(to bottom, rgba(255,239,206,0.97), rgba(255,227,176,0.62) 42%, rgba(255,217,150,0.04))',
              clipPath: 'polygon(26% 0, 74% 0, 92% 100%, 8% 100%)',
              filter: 'blur(2px)',
            }}
          />
          {/* 顶部灯口亮线 */}
          <div className="pointer-events-none absolute left-1/2 top-[1.1cqh] h-[0.4cqh] w-[42%] -translate-x-1/2 rounded-full bg-white/85 shadow-[0_0_8px_rgba(255,245,220,0.9)]" />
          <div className="relative z-10 pb-[1.2cqh] text-center text-[1.45cqw] text-white/85">亮度</div>
          {activeTarget === 'brightness' && (
            <div className="absolute -bottom-px -right-px z-20">
              <FingerPointer variant="tap" />
            </div>
          )}
        </div>

        {/* 2. 模式（光谱圆盘，点击循环 常规→暖1→绘画→夜读） */}
        <div
          data-tutorial-target="color-temp"
          className={`relative flex flex-[1.7] cursor-pointer flex-col items-center justify-center rounded-[1.6cqw] bg-[#26252b]/85 ${ring(activeTarget === 'color-temp')}`}
          onClick={onModeTap}
        >
          <SpectrumDial mode={mode} />
          <div className="mt-[1cqh] text-[1.5cqw]">
            <span className="font-medium text-amber-400">{mode.name}</span>
            <span className="text-white/85">模式</span>
          </div>
          {activeTarget === 'color-temp' && (
            <div className="absolute -bottom-px -right-px">
              <FingerPointer variant="tap" />
            </div>
          )}
        </div>

        {/* 3. 像距 + 开关灯（上下堆叠） */}
        <div className="flex flex-[1.45] flex-col gap-[1.4cqh]">
          {/* 像距（随模式变，哑控件） */}
          <div className="flex flex-1 flex-col items-center justify-center rounded-[1.6cqw] bg-[#26252b]/85">
            <div className="flex items-baseline gap-[0.55cqw] text-white/80">
              <svg viewBox="0 0 28 12" className="h-[1.5cqh] self-center" fill="none">
                <path
                  d="M1 6h26M1 6l3-3M1 6l3 3M27 6l-3-3M27 6l-3 3"
                  stroke="white"
                  strokeOpacity="0.7"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-[2.5cqw] font-semibold text-amber-400">{mode.distance}</span>
              <span className="text-[1.4cqw] text-white/70">米</span>
            </div>
            <div className="mt-[0.4cqh] text-[1.3cqw] text-white/55">像距</div>
          </div>
          {/* 开关灯（灯泡⚡ + 状态） */}
          <div
            data-tutorial-target={bulbTarget}
            className={`relative flex flex-1 cursor-pointer flex-col items-center justify-center rounded-[1.6cqw] ${lightOn ? 'bg-[#26252b]/85' : 'bg-[#1a1920]/85'} ${ring(isBulbActive)}`}
            onClick={() => fire(bulbTarget)}
          >
            <BulbBoltIcon on={lightOn} />
            <div className="mt-[0.4cqh] text-[1.45cqw] text-white/85">{lightOn ? '开灯' : '关灯'}</div>
            {isBulbActive && (
              <div className="absolute -bottom-px -right-px">
                <FingerPointer variant="tap" />
              </div>
            )}
          </div>
        </div>

        {/* 4. 音量（窄条整卡拖动） */}
        <div
          data-tutorial-target="volume"
          className={`relative flex flex-[0.68] cursor-pointer flex-col justify-end overflow-hidden rounded-[1.6cqw] bg-[#34333a]/80 ${ring(activeTarget === 'volume')}`}
          {...volDrag}
        >
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0"
            style={{
              height: `${volPct}%`,
              background: 'linear-gradient(to top, rgba(232,230,238,0.92), rgba(206,204,216,0.7))',
            }}
          />
          <div className="relative z-10 flex justify-center pb-[1.2cqh]">
            <svg viewBox="0 0 24 24" className="h-[2.6cqh]" fill="none">
              <path d="M4 9v6h3.5L13 19V5L7.5 9H4Z" fill={volPct > 12 ? '#3a3a42' : '#e8e6ee'} />
              <path
                d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"
                stroke={volPct > 12 ? '#3a3a42' : '#e8e6ee'}
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </div>
          {activeTarget === 'volume' && (
            <div className="absolute -bottom-px -right-px z-20">
              <FingerPointer variant="tap" />
            </div>
          )}
        </div>
      </div>

      {/* close-panel 上滑热区 */}
      {activeTarget === 'close-panel' && (
        <div
          data-tutorial-target="close-panel"
          className="absolute bottom-[3.6cqh] left-1/2 z-10 flex -translate-x-1/2 select-none items-center gap-[0.5cqw] rounded-full bg-white/10 px-[2.8cqw] py-[0.45cqh] text-[1.25cqw] text-white/75 active:bg-white/20"
          onClick={() => fire('close-panel')}
        >
          ↑ 上滑关闭
          <FingerPointer variant="tap" />
        </div>
      )}

      {/* home indicator 白色横杠 */}
      <div className="absolute bottom-[2.8cqh] left-1/2 h-[0.5cqh] w-[17cqw] -translate-x-1/2 rounded-full bg-white/80" />
    </div>
  );
}
