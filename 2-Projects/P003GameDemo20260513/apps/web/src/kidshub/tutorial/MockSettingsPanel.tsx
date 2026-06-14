import React, { useRef, useState } from 'react';
import { useTutorialStore } from './tutorial-store';
import type { TutorialTarget } from './tutorial-types';
import { GuidePointer, GuideRing } from './GuidePointer';

/**
 * MockSettingsPanel — 读写台设备设置面板（川哥 2026-06-14 重构：真实 pad 调节逻辑 + UI 方案 v1）
 *
 * 反人性重构（cc+gemini+grok 三方综合，对照设计图 settings面板UI方案v1.png）：
 *  - 亮度/音量：真实竖向滑块（粗轨道+大圆滑块头+图标+拖动浮百分比气泡）——告别整卡盲拖
 *  - 光谱模式：4 段选择器（图标+文字，点哪选哪）+ 圆盘预览——告别点击循环盲选
 *  - 像距：横向滑块 2.5~10 米 + 侧视示意图（屏幕随拖动前后移）——告别哑控件+荒谬数值
 *  - 开关灯：亮度卡底部灯泡按钮（台灯亮度+开关同区）
 *  - 重置：顶栏「恢复初始」一键回默认（gemini：孩子调乱的救命稻草）
 *  - 护耳上限：音量 >85% 滑块变红（gemini）
 *  - 指引：真 PNG 小手/箭头/光圈（GuidePointer/GuideRing）
 * 交互契约不变：data-tutorial-target + advanceOnAction(target) 推进引导。
 */

interface LightMode {
  name: string;
  icon: string;
  ring: string;
}
const LIGHT_MODES: LightMode[] = [
  { name: '常规', icon: '☀️', ring: 'conic-gradient(from 210deg,#22d3ee,#3b82f6,#a855f7,#22d3ee)' },
  { name: '暖光', icon: '🛋️', ring: 'radial-gradient(circle at 50% 40%,#fdf0d0,#eec07a)' },
  { name: '绘画', icon: '🎨', ring: 'conic-gradient(from 200deg,#38bdf8,#3b82f6,#818cf8,#38bdf8)' },
  { name: '夜读', icon: '🌙', ring: 'conic-gradient(from 210deg,#fb923c,#f59e0b,#fdba74,#fb923c)' },
];

const DEFAULTS = { bright: 64, vol: 52, mode: 0, dist: 5.5 };
const DIST_MIN = 2.5;
const DIST_MAX = 10;
const VOL_SAFE = 85; // 护耳上限

export function MockSettingsPanel({ activeTarget }: { activeTarget: TutorialTarget | null }) {
  const lightOn = useTutorialStore((s) => s.lightOn);
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
  const mode = LIGHT_MODES[modeIdx];

  const reset = () => {
    setBright(DEFAULTS.bright);
    setVol(DEFAULTS.vol);
    setModeIdx(DEFAULTS.mode);
    setDist(DEFAULTS.dist);
  };

  // 竖向滑块拖动（亮度/音量）：clientY → 0~100，可选首拖推进引导
  const dragRef = useRef<string | null>(null);
  const vDrag = (target: TutorialTarget, set: (n: number) => void) => {
    const apply = (clientY: number, el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (r.bottom - clientY) / r.height));
      set(Math.round(ratio * 100));
    };
    return {
      onPointerDown: (e: React.PointerEvent) => {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        dragRef.current = target;
        apply(e.clientY, e.currentTarget as HTMLElement);
        fire(target);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (dragRef.current !== target) return;
        apply(e.clientY, e.currentTarget as HTMLElement);
      },
      onPointerUp: () => {
        if (dragRef.current === target) dragRef.current = null;
      },
    };
  };

  // 像距横滑块（哑控件可调展示，2.5~10 米，不推进引导）
  const applyDist = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    setDist(Math.round((DIST_MIN + ratio * (DIST_MAX - DIST_MIN)) * 10) / 10);
  };
  const hDrag = {
    onPointerDown: (e: React.PointerEvent) => {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      dragRef.current = 'dist';
      applyDist(e.clientX, e.currentTarget as HTMLElement);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (dragRef.current !== 'dist') return;
      applyDist(e.clientX, e.currentTarget as HTMLElement);
    },
    onPointerUp: () => {
      if (dragRef.current === 'dist') dragRef.current = null;
    },
  };

  const bulbTarget: TutorialTarget = lightOn ? 'light-off' : 'light-on';
  const isBulbActive = activeTarget === bulbTarget;
  const distRatio = (dist - DIST_MIN) / (DIST_MAX - DIST_MIN);
  const volRed = vol > VOL_SAFE;

  // close-panel 上滑热区
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

  // 卡片激活高亮环
  const aring = (on: boolean) => (on ? 'ring-2 ring-amber-400/90 ring-offset-1 ring-offset-[#15171c]' : 'ring-1 ring-white/10');

  return (
    <div
      className={`absolute top-0 left-0 right-0 z-[65] overflow-hidden rounded-b-3xl border-b border-white/10 backdrop-blur-xl transition-transform duration-300 ease-out ${entered ? 'translate-y-0' : '-translate-y-[82%]'}`}
      style={{
        height: '100cqh',
        background:
          'radial-gradient(120% 85% at 50% 6%, rgba(38,40,54,0.94), rgba(26,28,40,0.96) 55%, rgba(16,17,26,0.98))',
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
        {/* 重置按钮 */}
        <button
          type="button"
          onClick={reset}
          className="flex items-center gap-[0.4cqw] rounded-full border border-white/15 bg-white/5 px-[1.4cqw] py-[0.45cqh] text-[1.3cqw] text-white/65 transition active:scale-95 hover:bg-white/10"
        >
          ↺ 恢复初始
        </button>
      </div>

      {/* 控件区 */}
      <div className="absolute inset-x-0 top-[12.5cqh] bottom-[9cqh] flex items-stretch gap-[1.6cqw] px-[2.6cqw]">
        {/* 1. 亮度（竖滑块 + 底部灯泡开关） */}
        <div className={`flex flex-[1] flex-col rounded-[1.6cqw] bg-[#26252b]/80 p-[1cqw] ${aring(activeTarget === 'brightness')}`}>
          <div className="relative flex flex-1 flex-col items-center">
            {/* 顶部 ☀ */}
            <div className="mb-[0.8cqh] text-[2.2cqw]">☀️</div>
            {/* 竖滑块（拖动区 = 整列轨道） */}
            <div
              data-tutorial-target="brightness"
              className="relative flex-1 cursor-pointer touch-none"
              style={{ width: '4.6cqw' }}
              {...vDrag('brightness', setBright)}
            >
              <div className="absolute left-1/2 top-0 h-full w-[2.6cqw] -translate-x-1/2 overflow-hidden rounded-full bg-white/12">
                <div className="absolute inset-x-0 bottom-0 rounded-full" style={{ height: `${bright}%`, background: 'linear-gradient(to top,#f59e0b,#fcd34d)' }} />
              </div>
              {/* 大圆滑块头 */}
              <div
                className="absolute left-1/2 h-[3.4cqw] w-[3.4cqw] -translate-x-1/2 translate-y-1/2 rounded-full border-[0.35cqw] border-amber-300 bg-white shadow-[0_1px_5px_rgba(0,0,0,0.4)]"
                style={{ bottom: `calc(${bright}% - 1.7cqw)` }}
              />
              {/* 百分比气泡 */}
              <div
                className="absolute left-[3.6cqw] -translate-y-1/2 rounded-md bg-black/55 px-[0.8cqw] py-[0.15cqh] text-[1.3cqw] font-medium text-white"
                style={{ bottom: `calc(${bright}% - 0.9cqw)` }}
              >
                {bright}%
              </div>
              {activeTarget === 'brightness' && <GuideRing />}
              {activeTarget === 'brightness' && (
                <div className="absolute -right-[5cqw] top-1/2 -translate-y-1/2">
                  <GuidePointer variant="tap" />
                </div>
              )}
            </div>
            <div className="mt-[0.7cqh] text-[1.45cqw] text-white/85">亮度</div>
          </div>
          {/* 灯泡开关 */}
          <button
            type="button"
            data-tutorial-target={bulbTarget}
            onClick={() => fire(bulbTarget)}
            className={`relative mt-[0.8cqh] flex items-center justify-center gap-[0.6cqw] rounded-[1cqw] py-[0.7cqh] text-[1.4cqw] transition ${lightOn ? 'bg-amber-400/15 text-amber-200' : 'bg-white/5 text-white/45'} ${isBulbActive ? 'ring-2 ring-amber-400' : ''}`}
          >
            <span style={{ filter: lightOn ? 'drop-shadow(0 0 4px #fcd34d)' : 'none' }}>{lightOn ? '💡' : '🔅'}</span>
            {lightOn ? '开灯' : '关灯'}
            {isBulbActive && (
              <div className="absolute -right-[1cqw] -top-[3cqh]">
                <GuidePointer variant="tap" />
              </div>
            )}
          </button>
        </div>

        {/* 2. 音量（竖滑块 + 护耳上限） */}
        <div className={`flex flex-[1] flex-col items-center rounded-[1.6cqw] bg-[#26252b]/80 p-[1cqw] ${aring(activeTarget === 'volume')}`}>
          <div className="mb-[0.8cqh] text-[2cqw]">{vol < 6 ? '🔇' : '🔊'}</div>
          <div
            data-tutorial-target="volume"
            className="relative flex-1 cursor-pointer touch-none"
            style={{ width: '4.6cqw' }}
            {...vDrag('volume', setVol)}
          >
            <div className="absolute left-1/2 top-0 h-full w-[2.6cqw] -translate-x-1/2 overflow-hidden rounded-full bg-white/12">
              <div className="absolute inset-x-0 bottom-0 rounded-full" style={{ height: `${vol}%`, background: volRed ? 'linear-gradient(to top,#dc2626,#f87171)' : 'linear-gradient(to top,#0ea5e9,#7dd3fc)' }} />
            </div>
            <div
              className={`absolute left-1/2 h-[3.4cqw] w-[3.4cqw] -translate-x-1/2 translate-y-1/2 rounded-full border-[0.35cqw] bg-white shadow-[0_1px_5px_rgba(0,0,0,0.4)] ${volRed ? 'border-red-400' : 'border-sky-300'}`}
              style={{ bottom: `calc(${vol}% - 1.7cqw)` }}
            />
            <div
              className="absolute left-[3.6cqw] -translate-y-1/2 rounded-md bg-black/55 px-[0.8cqw] py-[0.15cqh] text-[1.3cqw] font-medium text-white"
              style={{ bottom: `calc(${vol}% - 0.9cqw)` }}
            >
              {vol}%
            </div>
            {activeTarget === 'volume' && <GuideRing />}
            {activeTarget === 'volume' && (
              <div className="absolute -right-[5cqw] top-1/2">
                <GuidePointer variant="tap" />
              </div>
            )}
          </div>
          <div className="mt-[0.7cqh] text-[1.45cqw] text-white/85">音量{volRed && <span className="ml-[0.4cqw] text-[1.1cqw] text-red-400">护耳</span>}</div>
        </div>

        {/* 3. 光谱模式（圆盘预览 + 4 段选择器） */}
        <div
          data-tutorial-target="color-temp"
          className={`relative flex flex-[1.7] flex-col items-center rounded-[1.6cqw] bg-[#26252b]/80 p-[1cqw] ${aring(activeTarget === 'color-temp')}`}
        >
          {/* 圆盘预览 */}
          <div className="relative mt-[0.4cqh] h-[8.5cqh] w-[8.5cqh] shrink-0 rounded-full" style={{ background: mode.ring }}>
            <div className="absolute inset-[0.55cqh] rounded-full bg-[#15171c] shadow-[inset_0_0_8px_rgba(0,0,0,0.7)]" />
            <div className="absolute inset-0 flex items-center justify-center text-[2.6cqw]">{mode.icon}</div>
          </div>
          {/* 4 段选择器 2x2 */}
          <div className="mt-[1cqh] grid w-full grid-cols-2 gap-[0.7cqw]">
            {LIGHT_MODES.map((m, i) => (
              <button
                key={m.name}
                type="button"
                onClick={() => {
                  setModeIdx(i);
                  fire('color-temp');
                }}
                className={`flex items-center justify-center gap-[0.4cqw] rounded-[0.9cqw] py-[0.85cqh] text-[1.4cqw] transition active:scale-95 ${
                  i === modeIdx ? 'bg-amber-400/90 font-medium text-neutral-900 shadow-[0_2px_8px_rgba(245,158,11,0.4)]' : 'bg-white/8 text-white/70 hover:bg-white/14'
                }`}
              >
                <span>{m.icon}</span>
                {m.name}
              </button>
            ))}
          </div>
          <div className="mt-[0.7cqh] text-[1.45cqw] text-white/85">光谱模式</div>
          {activeTarget === 'color-temp' && (
            <div className="absolute bottom-[1cqh] right-[1cqw]">
              <GuidePointer variant="tap" />
            </div>
          )}
        </div>

        {/* 4. 像距（侧视示意图 + 横滑块 2.5~10米） */}
        <div className="flex flex-[1.5] flex-col items-center justify-center rounded-[1.6cqw] bg-[#26252b]/80 p-[1.2cqw]">
          {/* 侧视示意图：眼睛 ←···屏幕··· */}
          <div className="relative mb-[0.6cqh] h-[7cqh] w-full">
            <div className="absolute left-[3%] top-1/2 -translate-y-1/2 text-[3cqw]">👀</div>
            {/* 距离虚线 */}
            <div className="absolute left-[16%] right-[8%] top-1/2 h-px -translate-y-1/2 border-t border-dashed border-white/25" />
            {/* 屏幕图标随 dist 在 16%~88% 移动 */}
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 transition-[left] duration-100"
              style={{ left: `${16 + distRatio * 72}%` }}
            >
              <div className="flex h-[4.5cqh] w-[3.2cqh] items-center justify-center rounded-[0.5cqw] border border-sky-300/70 bg-sky-400/15 text-[1.6cqw]">📺</div>
            </div>
          </div>
          {/* 数值 */}
          <div className="text-[2.8cqw] font-semibold text-amber-400">
            {dist.toFixed(1)} <span className="text-[1.5cqw] text-white/70">米</span>
          </div>
          {/* 横滑块 */}
          <div className="relative mt-[0.5cqh] h-[3.4cqh] w-[88%] cursor-pointer touch-none" {...hDrag}>
            <div className="absolute left-0 right-0 top-1/2 h-[1cqh] -translate-y-1/2 overflow-hidden rounded-full bg-white/12">
              <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-teal-400 to-amber-400" style={{ width: `${distRatio * 100}%` }} />
            </div>
            <div
              className="absolute top-1/2 h-[3cqw] w-[3cqw] -translate-x-1/2 -translate-y-1/2 rounded-full border-[0.3cqw] border-amber-300 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.4)]"
              style={{ left: `${distRatio * 100}%` }}
            />
          </div>
          <div className="mt-[0.3cqh] flex w-[88%] justify-between text-[1.1cqw] text-white/40">
            <span>{DIST_MIN}米 近</span>
            <span>远 {DIST_MAX}米</span>
          </div>
          <div className="mt-[0.5cqh] text-[1.45cqw] text-white/85">像距</div>
        </div>
      </div>

      {/* close-panel 上滑热区（箭头指引） */}
      {activeTarget === 'close-panel' && (
        <div
          data-tutorial-target="close-panel"
          className="absolute bottom-[3.2cqh] left-1/2 z-10 flex -translate-x-1/2 select-none flex-col items-center gap-[0.3cqh] active:scale-95"
          onClick={() => fire('close-panel')}
        >
          <GuidePointer variant="swipe-up" />
          <span className="rounded-full bg-white/10 px-[2.2cqw] py-[0.4cqh] text-[1.2cqw] text-white/75">上滑关闭</span>
        </div>
      )}

      {/* home indicator */}
      <div className="absolute bottom-[2.4cqh] left-1/2 h-[0.5cqh] w-[16cqw] -translate-x-1/2 rounded-full bg-white/70" />
    </div>
  );
}
