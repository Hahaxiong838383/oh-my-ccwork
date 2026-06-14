import { useEffect, useRef, useState } from 'react';
import { useTutorialStore, currentStep } from './tutorial-store';

let _audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext | null {
  if (!_audioCtx) {
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (AC) _audioCtx = new AC();
    } catch {}
  }
  return _audioCtx;
}
function playAlarmBeeps() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const baseFreq = 940;
    [0, 195, 395].forEach((d, i) => {
      setTimeout(() => {
        try {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const filter = ctx.createBiquadFilter();
          osc.type = 'sawtooth';
          osc.frequency.value = baseFreq + (i === 1 ? -22 : 6);
          filter.type = 'lowpass'; filter.frequency.value = 2600;
          const t = ctx.currentTime;
          gain.gain.value = 0.22;
          gain.gain.setValueAtTime(0.22, t);
          gain.gain.linearRampToValueAtTime(0.001, t + 0.12);
          osc.connect(filter).connect(gain).connect(ctx.destination);
          osc.start(t); osc.stop(t + 0.155);
        } catch {}
      }, d);
    });
  } catch {}
}

function SceneImg({ src, alt, fallback }: { src: string; alt: string; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (failed) return <>{fallback}</>;
  return <img src={src} alt={alt} className="absolute inset-0 h-full w-full object-cover" onError={() => setFailed(true)} draggable={false} />;
}

export function BoardingCanvasContent(): JSX.Element {
  const stepIndex = useTutorialStore((s) => s.stepIndex);
  const advanceOnAction = useTutorialStore((s) => s.advanceOnAction);
  const step = currentStep({ unitId: 'boarding', stepIndex });
  const scene = (step?.scene ?? 'alert') as 'alert'|'storm'|'crash'|'rescue'|'celebrate';
  const showBoot = scene === 'rescue' && step?.waitFor === 'boot-button';

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

  useEffect(() => { if (step?.sound === 'alarm') playAlarmBeeps(); }, [step?.id]);

  const shakeStyle = displayScene === 'alert' ? { animation: 'alertShake 520ms infinite ease-in-out' }
    : (displayScene === 'storm' || displayScene === 'crash') ? { animation: 'stormShake 165ms infinite linear' } : {};

  return (
    <div className="absolute inset-0 overflow-hidden text-white" style={{ fontSize: 'inherit' }}>
      <style>{`
        @keyframes alertShake{0%,100%{transform:translate(0,0)}25%{transform:translate(1.4cqw,-0.8cqh)}50%{transform:translate(-1.1cqw,1.0cqh)}75%{transform:translate(0.9cqw,-0.6cqh)}}
        @keyframes stormShake{0%,100%{transform:translate(0,0)}12%{transform:translate(0.55cqw,-0.38cqh)}24%{transform:translate(-0.48cqw,0.62cqh)}37%{transform:translate(0.38cqw,0.31cqh)}51%{transform:translate(-0.61cqw,-0.42cqh)}66%{transform:translate(0.29cqw,0.55cqh)}79%{transform:translate(-0.35cqw,-0.27cqh)}91%{transform:translate(0.42cqw,0.18cqh)}}
        @keyframes warningPulse{0%,100%{opacity:.65;transform:scale(.92)}50%{opacity:1;transform:scale(1.07)}}
        @keyframes vignetteBreath{0%,100%{opacity:.32}50%{opacity:.72}}
        @keyframes shipFly{0%{left:-11%;bottom:6%;transform:rotate(-22deg)}100%{left:104%;bottom:71%;transform:rotate(14deg)}}
        @keyframes sadSlide{0%{left:-34%;top:41%;transform:rotate(-26deg)scale(.94)}100%{left:29%;top:29%;transform:rotate(-4deg)scale(1)}}
        @keyframes sadBreathe{0%,100%{transform:translateY(0)rotate(-3deg)}50%{transform:translateY(-1.6cqh)rotate(2.5deg)}}
        @keyframes bootPop{0%{transform:scale(.18);opacity:0}65%{transform:scale(1.12);opacity:1}100%{transform:scale(1)}}
        @keyframes bootRing{0%{transform:scale(.82);opacity:.65}70%{transform:scale(1.32);opacity:.1}100%{transform:scale(1.38);opacity:0}}
        @keyframes goldFloat{0%{transform:translateY(7cqh)scale(.7);opacity:.88}35%{opacity:.97}100%{transform:translateY(-48cqh)scale(.25);opacity:0}}
        @keyframes dustDrift{0%,100%{transform:translate(0,0);opacity:.55}50%{transform:translate(1.8cqw,-2.4cqh);opacity:.82}}
        @keyframes redSidePulse{0%,100%{opacity:.22}50%{opacity:.68}}
        @keyframes bgBrighten{0%{filter:brightness(.35)}100%{filter:brightness(1)}}
        @keyframes streakSweep{0%{transform:translate(0,0)}100%{transform:translate(-170cqw,85cqh)}}
      `}</style>

      <div className="absolute inset-0 transition-opacity duration-[300ms] ease-out" style={{ opacity: sceneOpacity, ...shakeStyle }}>
        {displayScene === 'alert' && (
          <div className="absolute inset-0 bg-black">
            <div className="pointer-events-none absolute inset-0" style={{ boxShadow: 'inset 0 0 72px 46px rgba(185,12,12,.55)', animation: 'vignetteBreath 1350ms infinite ease-in-out' }} />
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[21cqw] text-red-500/90 drop-shadow-[0_0_18px_rgba(220,10,10,.85)] select-none" style={{ animation: 'warningPulse 980ms infinite ease-in-out' }}>⚠️</div>
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(180,0,0,.18)_0%,transparent_68%)]" />
          </div>
        )}

        {displayScene === 'storm' && (
          <div className="absolute inset-0 bg-[#0d2238]">
            <SceneImg src="/kidshub/boarding/storm.webp" alt="风暴" fallback={<div className="absolute inset-0 bg-gradient-to-br from-[#1a0b33] via-[#3b1466] to-[#0d2238]">{[{l:'8%',t:'12%',w:'72%',r:-27,d:'0ms'},{l:'22%',t:'-6%',w:'58%',r:-31,d:'260ms'},{l:'-4%',t:'34%',w:'81%',r:-25,d:'520ms'}].map((s,i)=>(<div key={i} className="absolute h-[0.9cqh] bg-white/35" style={{left:s.l,top:s.t,width:s.w,transform:`rotate(${s.r}deg)`,animation:`streakSweep 1450ms linear ${s.d} infinite`}}/>))}</div>} />
            <div className="absolute text-[5.8cqw] drop-shadow-[0_0_8px_rgba(255,255,255,.6)] select-none" style={{ animation: 'shipFly 4800ms linear infinite' }}>🚀</div>
            {[0,1,2].map(k=>(<div key={k} className="absolute h-[0.9cqw] w-[0.9cqw] rounded-full bg-white/70" style={{animation:`shipFly 4800ms linear ${-280-k*210}ms infinite`,opacity:.35-k*.08}}/>))}
          </div>
        )}

        {displayScene === 'crash' && (
          <div className="absolute inset-0 bg-[#0d2238]">
            <SceneImg src="/kidshub/boarding/storm.webp" alt="坠落" fallback={<div className="absolute inset-0 bg-gradient-to-br from-[#140a28] via-[#2a0f4a] to-[#091a2a]" />} />
            <div className="absolute inset-0 bg-black/35" />
            <img src="/kidshub/expressions/net-sad.webp" alt="伤心" className="absolute select-none" style={{ width: '31cqw', animation: 'sadSlide 1850ms ease-out forwards, sadBreathe 1350ms 1950ms infinite ease-in-out' }} draggable={false} />
          </div>
        )}

        {displayScene === 'rescue' && (
          <div className="absolute inset-0 bg-[#0a1628]">
            <SceneImg src="/kidshub/boarding/damaged.webp" alt="受损舱" fallback={<div className="absolute inset-0 bg-gradient-to-b from-[#0a1628] via-[#132a42] to-[#0d2238]"><div className="absolute inset-y-0 left-0 w-[38%] bg-[radial-gradient(circle_at_12%_50%,rgba(220,40,40,.55)_0%,transparent_72%)]" style={{animation:'redSidePulse 1250ms infinite ease-in-out'}}/><div className="absolute inset-y-0 right-0 w-[38%] bg-[radial-gradient(circle_at_88%_50%,rgba(220,40,40,.55)_0%,transparent_72%)]" style={{animation:'redSidePulse 1250ms infinite ease-in-out 380ms'}}/></div>} />
            {[{l:'17%',t:'22%'},{l:'31%',t:'61%'},{l:'58%',t:'19%'},{l:'74%',t:'47%'},{l:'42%',t:'73%'},{l:'23%',t:'44%'},{l:'81%',t:'29%'}].map((p,i)=>(<div key={i} className="absolute h-[0.55cqw] w-[0.55cqw] rounded-full bg-white/55" style={{...p,animation:`dustDrift ${2100+(i%3)*420}ms infinite ease-in-out ${i*170}ms`}}/>))}
          </div>
        )}

        {displayScene === 'celebrate' && (
          <div className="absolute inset-0 bg-black" style={{ animation: 'bgBrighten 2100ms ease-out forwards' }}>
            <SceneImg src="/kidshub/boarding/ecopond.webp" alt="生态" fallback={<div className="absolute inset-0 bg-gradient-to-br from-[#0d2238] via-[#0f4a4a] to-[#3d6b2f]"><div className="absolute left-1/2 top-[29%] -translate-x-1/2 rounded-[3.8cqw] bg-[#14b8a6] shadow-[0_0_46px_#14b8a6,0_0_86px_#0f766e] opacity-80" style={{width:'48cqw',height:'37cqh'}}/></div>} />
            <div className="pointer-events-none absolute -top-[18%] left-1/2 h-[46%] w-[68%] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,#fde047_0%,#f59e0b_32%,transparent_72%)] opacity-35" />
            {Array.from({length:16}).map((_,i)=>(<div key={i} className="absolute h-[0.7cqw] w-[0.7cqw] rounded-full bg-[#fde047]" style={{left:`${8+((i*4.7)%81)}%`,bottom:`${-1+(i%5)*1.6}%`,opacity:.75+(i%3)*.07,animation:`goldFloat ${1850+(i%5)*180}ms infinite ease-in ${((i*97)%1350)}ms`,boxShadow:i%4===0?'0 0 6px #facc15':undefined}}/>))}
          </div>
        )}
      </div>

      {showBoot && (
        <button type="button" data-tutorial-target="boot-button" onClick={() => advanceOnAction('boot-button')} className="absolute left-1/2 bottom-[19%] z-40 flex -translate-x-1/2 flex-col items-center justify-center rounded-full select-none transition-all active:scale-[0.94] hover:scale-[1.06]" style={{width:'17.4cqw',height:'17.4cqw',background:'linear-gradient(145deg,#fde047,#f59e0b 48%,#d97706)',boxShadow:'0 0 0 1.6cqw rgba(245,158,11,.22), inset 0 -2.2cqw 3.6cqw rgba(0,0,0,.18)',animation:'bootPop 420ms cubic-bezier(0.18,0.89,0.32,1.28) forwards'}} aria-label="启动方舟">
          <div className="pointer-events-none absolute rounded-full border-[1.4cqw] border-amber-300/70" style={{width:'22.6cqw',height:'22.6cqw',animation:'bootRing 1350ms infinite ease-out'}} />
          <div className="text-[7.4cqw] leading-none drop-shadow-sm">🚀</div>
          <div className="mt-[0.1cqh] text-[1.65cqw] font-semibold tracking-[0.04em] text-neutral-900/90">启动方舟</div>
        </button>
      )}
    </div>
  );
}