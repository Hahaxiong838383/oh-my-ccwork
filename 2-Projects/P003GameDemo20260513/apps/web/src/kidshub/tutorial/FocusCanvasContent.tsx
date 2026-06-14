import { useEffect, useRef, useState } from 'react';
import { useTutorialStore, currentStep } from './tutorial-store';

function SceneImg({ src, alt, fallback }: { src: string; alt: string; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (failed) return <>{fallback}</>;
  return <img src={src} alt={alt} className="absolute inset-0 h-full w-full object-cover" onError={() => setFailed(true)} draggable={false} />;
}

export function FocusCanvasContent(): JSX.Element {
  const stepIndex = useTutorialStore((s) => s.stepIndex);
  const advanceOnAction = useTutorialStore((s) => s.advanceOnAction);
  const step = currentStep({ unitId: 'focus', stepIndex });
  const scene = (step?.scene ?? 'focus-intro') as 'focus-intro' | 'focus-progress' | 'focus-counting' | 'chest-ready' | 'chest-open' | 'focus-summary';

  // 幕过渡 300ms（同 NightReport/Boarding）
  const [displayScene, setDisplayScene] = useState(scene);
  const [sceneOpacity, setSceneOpacity] = useState(1);
  const prevSceneRef = useRef<string>(scene);
  useEffect(() => {
    if (scene !== prevSceneRef.current) {
      setSceneOpacity(0);
      const t = setTimeout(() => { setDisplayScene(scene); setSceneOpacity(1); }, 160);
      prevSceneRef.current = scene;
      return () => clearTimeout(t);
    }
  }, [scene]);

  const [progress, setProgress] = useState(0);
  const progIntervalRef = useRef<number>(0);
  const [chestOpen, setChestOpen] = useState(false);
  const [showFlash, setShowFlash] = useState(false);
  const [showPops, setShowPops] = useState(false);
  const timersRef = useRef<number[]>([]);

  // 场景进入重置+启动计数/开箱（setInterval 驱动进度，防 rAF 后台 0Hz 坑）
  useEffect(() => {
    window.clearInterval(progIntervalRef.current);
    timersRef.current.forEach(clearTimeout); timersRef.current = [];
    const reset = () => { setProgress(0); setChestOpen(false); setShowFlash(false); setShowPops(false); };
    if (displayScene === 'focus-intro' || displayScene === 'focus-progress') reset();
    if (displayScene === 'focus-counting') {
      setProgress(0); setChestOpen(false); setShowFlash(false); setShowPops(false);
      const duration = 5000; const startTime = performance.now();
      progIntervalRef.current = window.setInterval(() => {
        const p = Math.min(1, (performance.now() - startTime) / duration);
        const pct = Math.round(p * 100); setProgress(pct);
        if (p >= 1) { window.clearInterval(progIntervalRef.current); setProgress(100); }
      }, 33);
    }
    if (displayScene === 'chest-ready') { setProgress(100); setChestOpen(false); setShowFlash(false); setShowPops(false); }
    if (displayScene === 'chest-open') {
      setProgress(100); setChestOpen(false); setShowFlash(false); setShowPops(false);
      const tOpen = window.setTimeout(() => setChestOpen(true), 520);
      const tPops = window.setTimeout(() => setShowPops(true), 680);
      const tFlash = window.setTimeout(() => { setShowFlash(true); const th = window.setTimeout(() => setShowFlash(false), 280); timersRef.current.push(th); }, 980);
      timersRef.current.push(tOpen, tPops, tFlash);
    }
    if (displayScene === 'focus-summary') { setProgress(100); setChestOpen(false); setShowFlash(false); setShowPops(false); }
  }, [displayScene]);

  // 卸载清理
  useEffect(() => () => { window.clearInterval(progIntervalRef.current); timersRef.current.forEach(clearTimeout); }, []);

  const isClaimStep = step?.waitFor === 'claim-reward';
  const showPosture = displayScene === 'focus-intro' && (step?.id === '2' || step?.specStep === '2');

  const TopBar = (
    <div className="absolute top-0 left-0 right-0 h-[8.8cqh] z-[58] flex items-center px-[2.4cqw] bg-gradient-to-b from-black/30 to-transparent pointer-events-none">
      <div className="flex items-center gap-[1.1cqw]">
        <div className="flex items-center gap-[0.45cqw] rounded-full bg-white/90 px-[1.35cqw] py-[0.25cqh] text-neutral-900 text-[1.65cqw] shadow-sm"><span>🪙</span><span className="font-medium tracking-tight">123456</span></div>
        <div className="flex items-center gap-[0.45cqw] rounded-full bg-white/90 px-[1.35cqw] py-[0.25cqh] text-neutral-900 text-[1.65cqw] shadow-sm"><span>✨</span><span className="font-medium tracking-tight tabular-nums">999</span></div>
      </div>
    </div>
  );

  const FocusProgressBar = ({ pct, highlight, showPct }: { pct: number; highlight?: boolean; showPct?: boolean }) => (
    <div className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-[1.1cqw] rounded-full border border-teal-400/80 bg-black/45 px-[1.4cqw] py-[0.65cqh] ${highlight ? 'ring-2 ring-yellow-300 z-[42]' : ''}`} style={{ width: '68cqw', bottom: '13.5cqh' }}>
      <div className="text-[1.85cqw] select-none">📦</div>
      <div className="relative flex-1 h-[1.65cqh] rounded-full bg-white/10 overflow-hidden border border-white/20">
        <div className="absolute left-0 top-0 h-full rounded-full bg-gradient-to-r from-teal-400 via-teal-300 to-teal-400 transition-[width] duration-75" style={{ width: `${pct}%` }} />
        {pct > 0 && pct < 100 && <div className="absolute top-0 h-full w-[22%] bg-gradient-to-r from-transparent via-white/70 to-transparent" style={{ left: `${Math.max(0, Math.min(78, pct - 11))}%`, animation: 'shineSweep 820ms linear infinite' }} />}
        {pct >= 100 && <div className="absolute inset-0 bg-[linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent)]" style={{ animation: 'shineSweep 820ms linear infinite' }} />}
      </div>
      {showPct && <div className="w-[4.8cqw] text-right text-[1.45cqw] font-medium tabular-nums text-white/90">{pct}%</div>}
    </div>
  );

  return (
    <div className="absolute inset-0 overflow-hidden text-white" style={{ fontSize: 'inherit' }}>
      <style>{`
        @keyframes dustDrift{0%,100%{transform:translate(0,0);opacity:.55}50%{transform:translate(1.8cqw,-2.4cqh);opacity:.82}}
        @keyframes goldFloat{0%{transform:translateY(7cqh)scale(.7);opacity:.88}35%{opacity:.97}100%{transform:translateY(-48cqh)scale(.25);opacity:0}}
        @keyframes chestDrop{0%{transform:translateY(-21cqh) scale(.62);opacity:.55}46%{transform:translateY(3.8cqh) scale(1.12)}64%{transform:translateY(-1.6cqh) scale(.95)}100%{transform:translateY(0) scale(1);opacity:1}}
        @keyframes beamRise{0%{opacity:0;transform:scaleY(.25)}55%{opacity:.82}100%{opacity:.55;transform:scaleY(1)}}
        @keyframes popUp{0%{transform:translateY(2.8cqh) scale(.38);opacity:0}22%{opacity:1}100%{transform:translateY(-17cqh) scale(.22);opacity:0}}
        @keyframes flashFade{0%{opacity:.62}100%{opacity:0}}
        @keyframes shineSweep{0%{transform:translateX(-120%)}100%{transform:translateX(260%)}}
        @keyframes chestPop{0%{transform:scale(.6);opacity:.6}60%{transform:scale(1.08);opacity:1}100%{transform:scale(1)}}
        @keyframes goldUp{0%{transform:translateY(0) scale(.78);opacity:.92}100%{transform:translateY(-21cqh) scale(.18);opacity:0}}
        @keyframes fireworkL{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(-9.5cqw,-16.5cqh) scale(.25);opacity:0}}
        @keyframes fireworkR{0%{transform:translate(0,0) scale(1);opacity:1}100%{transform:translate(9.5cqw,-16.5cqh) scale(.25);opacity:0}}
        @keyframes sitFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-0.9cqh)}}
        @keyframes btnScaleIn{0%{transform:scale(.72);opacity:0}55%{transform:scale(1.04);opacity:1}100%{transform:scale(1)}}
        @keyframes btnPulse{0%,100%{box-shadow:0 0 0 1.1cqw rgba(245,158,11,.18)}50%{box-shadow:0 0 0 2.6cqw rgba(245,158,11,.32)}}
      `}</style>

      <div className="absolute inset-0 transition-opacity duration-[300ms] ease-out" style={{ opacity: sceneOpacity }}>
        <SceneImg src="/kidshub/boarding/ecopond.webp" alt="生态缸" fallback={<div className="absolute inset-0 bg-gradient-to-br from-[#0d2238] via-[#0f4a4a] to-[#3d6b2f]"><div className="absolute left-1/2 top-[29%] -translate-x-1/2 rounded-[3.8cqw] bg-[#14b8a6] shadow-[0_0_46px_#14b8a6,0_0_86px_#0f766e] opacity-80" style={{ width: '48cqw', height: '37cqh' }} /></div>} />

        {displayScene === 'focus-intro' && (
          <>
            <FocusProgressBar pct={0} />
            {showPosture && <div className="absolute left-[11%] bottom-[22%] z-20 text-[2.6cqw] select-none pointer-events-none" style={{ animation: 'sitFloat 1680ms infinite ease-in-out' }}>🧘</div>}
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="absolute h-[0.5cqw] w-[0.5cqw] rounded-full bg-[#fde047]/60 pointer-events-none" style={{ left: `${11 + i * 17}%`, top: `${31 + (i % 2) * 9}%`, animation: `dustDrift ${2100 + i * 260}ms infinite ease-in-out ${i * 140}ms` }} />)}
          </>
        )}

        {displayScene === 'focus-progress' && (
          <>
            <div className="absolute inset-0 bg-black/45 pointer-events-none" />
            <div className="absolute left-1/2 -translate-x-1/2 z-[42] pointer-events-none" style={{ width: '68cqw', bottom: '13.5cqh' }}><div className="absolute -inset-3 rounded-[2.4cqw] bg-yellow-300/10" /></div>
            <FocusProgressBar pct={0} highlight />
          </>
        )}

        {displayScene === 'focus-counting' && <FocusProgressBar pct={progress} showPct />}

        {displayScene === 'chest-ready' && (
          <>
            <FocusProgressBar pct={100} />
            <div className="absolute left-1/2 -translate-x-1/2 z-30 pointer-events-none" style={{ bottom: '24.5cqh', animation: 'chestDrop 680ms cubic-bezier(0.18,.92,.3,1) forwards' }}>
              <div className="relative" style={{ width: '13.2cqw', height: '10.2cqh' }}>
                <div className="absolute bottom-0 inset-x-[7%] h-[57%] rounded-b-[1.05cqw] bg-gradient-to-b from-amber-700 via-amber-800 to-[#3a271c] border border-amber-900/75 shadow-[inset_0_1.1cqh_2.2cqh_rgba(0,0,0,.35)]" />
                <div className="absolute inset-x-[2%] top-[4%] h-[43%] rounded-t-[1.1cqw] bg-gradient-to-b from-amber-500 to-amber-700 border border-amber-800/70" style={{ boxShadow: '0 1.5cqh 2.6cqh rgba(0,0,0,.28)' }} />
                <div className="absolute left-1/2 top-[28%] -translate-x-1/2 text-[1.7cqw] text-amber-200/70">🔒</div>
                <div className="absolute bottom-[33%] inset-x-[11%] h-[1.6px] bg-yellow-900/55" />
              </div>
            </div>
            {isClaimStep && <button type="button" data-tutorial-target="claim-reward" onClick={() => advanceOnAction('claim-reward')} className="absolute left-1/2 z-50 flex -translate-x-1/2 items-center justify-center gap-[0.6cqw] rounded-2xl select-none text-[1.72cqw] font-semibold tracking-[0.02em] text-neutral-900 transition-all active:scale-[0.96] hover:scale-[1.02]" style={{ bottom: '8.8cqh', width: '27.5cqw', height: '5.6cqh', background: 'linear-gradient(145deg,#fde047,#f59e0b 46%,#d97706)', boxShadow: '0 0 0 1.1cqw rgba(245,158,11,.22), inset 0 -1.8cqh 3.2cqh rgba(0,0,0,.18)', animation: 'btnScaleIn 380ms cubic-bezier(0.18,0.89,0.32,1.28) forwards, btnPulse 1350ms infinite ease-out 420ms' }}>🎁 获取奖励</button>}
          </>
        )}

        {displayScene === 'chest-open' && (
          <>
            <FocusProgressBar pct={100} />
            <div className="absolute left-1/2 -translate-x-1/2 z-30 pointer-events-none" style={{ bottom: '24.5cqh', animation: 'chestPop 420ms ease-out forwards' }}>
              <div className="relative" style={{ width: '13.2cqw', height: '10.2cqh' }}>
                <div className="absolute bottom-0 inset-x-[7%] h-[57%] rounded-b-[1.05cqw] bg-gradient-to-b from-amber-700 via-amber-800 to-[#3a271c] border border-amber-900/75 shadow-[inset_0_1.1cqh_2.2cqh_rgba(0,0,0,.35)]" />
                <div className="absolute inset-x-[2%] top-[4%] h-[43%] rounded-t-[1.1cqw] bg-gradient-to-b from-amber-500 to-amber-700 border border-amber-800/70" style={{ transformOrigin: 'center 84%', transform: chestOpen ? 'rotate(-126deg) translateY(-1.6cqh)' : 'rotate(0deg)', transition: chestOpen ? 'transform 240ms cubic-bezier(0.22,1,0.32,1.05)' : 'none', boxShadow: chestOpen ? '0 -1.1cqh 3cqh rgba(0,0,0,.32)' : '0 1.5cqh 2.6cqh rgba(0,0,0,.28)' }} />
                <div className="absolute bottom-[33%] inset-x-[11%] h-[1.6px] bg-yellow-900/55" />
              </div>
            </div>
            {(chestOpen || showPops) && <div className="absolute left-1/2 top-[52%] -translate-x-1/2 z-20 pointer-events-none w-[15cqw]">
              <div className="absolute left-1/2 -translate-x-1/2 -mt-[10.5cqh] h-[14.8cqh] w-[2.7cqw] bg-gradient-to-t from-yellow-300/70 via-amber-200/50 to-transparent rounded-full" style={{ animation: 'beamRise 320ms ease-out forwards' }} />
              {showPops && ['⭐','💎','🌟','✨','⭐','💎','🎈'].map((ic,i)=><div key={i} className="absolute text-[1.65cqw]" style={{ left: `calc(50% + ${(i-3)*3.9}cqw)`, bottom: '0.3cqh', animation: `popUp ${720+(i%3)*48}ms ease-out ${i*52+40}ms forwards` }}>{ic}</div>)}
            </div>}
            {showPops && <>
              {Array.from({ length: 4 }).map((_,i)=><div key={'l'+i} className="absolute h-[0.42cqw] w-[0.42cqw] rounded-full pointer-events-none z-10" style={{ left: '29%', top: '46%', background: ['#f43f5e','#facc15','#38bdf8','#a3e635'][i%4], animation: `fireworkL ${680+i*70}ms ease-out ${i*45}ms forwards` }} />)}
              {Array.from({ length: 4 }).map((_,i)=><div key={'r'+i} className="absolute h-[0.42cqw] w-[0.42cqw] rounded-full pointer-events-none z-10" style={{ left: '71%', top: '46%', background: ['#f43f5e','#facc15','#38bdf8','#a3e635'][i%4], animation: `fireworkR ${680+i*70}ms ease-out ${i*45+35}ms forwards` }} />)}
            </>}
            {showFlash && <div className="absolute inset-0 pointer-events-none z-10 bg-[radial-gradient(circle_at_50%_61%,rgba(253,224,71,0.55)_0%,transparent_54%)]" style={{ animation: 'flashFade 260ms linear forwards' }} />}
          </>
        )}

        {displayScene === 'focus-summary' && (
          <>
            <div className="absolute left-1/2 -translate-x-1/2 z-20 pointer-events-none transition-all duration-300" style={{ bottom: '24.5cqh', transform: 'scale(0.72)', opacity: 0.55 }}>
              <div className="relative" style={{ width: '11cqw', height: '8.4cqh' }}><div className="absolute bottom-0 inset-x-[7%] h-[57%] rounded-b-[1.05cqw] bg-gradient-to-b from-amber-700 via-amber-800 to-[#3a271c] border border-amber-900/75" /><div className="absolute inset-x-[2%] top-[4%] h-[43%] rounded-t-[1.1cqw] bg-gradient-to-b from-amber-500 to-amber-700 border border-amber-800/70" /></div>
            </div>
            <FocusProgressBar pct={100} />
            {Array.from({ length: 5 }).map((_,i)=><div key={i} className="absolute h-[0.55cqw] w-[0.55cqw] rounded-full bg-[#fde047] pointer-events-none z-20" style={{ left: `${26+((i*8)%46)}%`, top: `${34+(i%3)*2.3}%`, animation: `goldUp ${1480+(i%4)*120}ms ease-out forwards ${i*65}ms`, opacity: 0.8 }} />)}
          </>
        )}
      </div>

      {/* 顶部资源栏（所有幕共用） */}
      {TopBar}
    </div>
  );
}
