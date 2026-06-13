import { useEffect, useRef, useState } from 'react';
import { useTutorialStore, currentStep } from './tutorial-store';

function SceneImg({ src, alt, fallback }: { src: string; alt: string; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (failed) return <>{fallback}</>;
  return <img src={src} alt={alt} className="absolute inset-0 h-full w-full object-cover" onError={() => setFailed(true)} draggable={false} />;
}

export function EcoPondCanvasContent(): JSX.Element {
  const stepIndex = useTutorialStore((s) => s.stepIndex);
  const step = currentStep({ unitId: 'eco-pond', stepIndex });
  const scene = (step?.scene ?? 'pond-view') as 'pond-view' | 'seed-rise' | 'seed-card' | 'pond-finale';

  // 幕过渡：300ms 透明度切场
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

  // 种子/卡片阶段状态（纯视觉驱动）
  const [seedPhase, setSeedPhase] = useState<'hidden' | 'rising' | 'floating' | 'rooted'>('hidden');
  const [showCard, setShowCard] = useState(false);
  const [showRipples, setShowRipples] = useState(false);

  const timersRef = useRef<number[]>([]);

  // 场景进入副作用：启动种子升起/卡片/根植序列 + 清理
  useEffect(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    if (displayScene === 'pond-view') {
      setSeedPhase('hidden');
      setShowCard(false);
      setShowRipples(false);
    }
    if (displayScene === 'seed-rise') {
      setSeedPhase('hidden');
      setShowCard(false);
      setShowRipples(false);
      // 4s 纯特效：先升起再悬浮（setInterval 仅用于阶段切换，匹配 durationMs）
      const tRise = window.setTimeout(() => setSeedPhase('rising'), 60);
      const tFloat = window.setTimeout(() => setSeedPhase('floating'), 2650);
      timersRef.current.push(tRise, tFloat);
    }
    if (displayScene === 'seed-card') {
      setSeedPhase('floating');
      setShowCard(false);
      setShowRipples(false);
      const tCard = window.setTimeout(() => setShowCard(true), 180);
      timersRef.current.push(tCard);
    }
    if (displayScene === 'pond-finale') {
      setShowCard(false);
      setSeedPhase('floating');
      setShowRipples(false);
      // 种子落入缸区生根 + 涟漪 + 全局光晕
      const tDesc = window.setTimeout(() => setSeedPhase('rooted'), 280);
      const tRip = window.setTimeout(() => {
        setShowRipples(true);
        const tHide = window.setTimeout(() => setShowRipples(false), 1250);
        timersRef.current.push(tHide);
      }, 820);
      timersRef.current.push(tDesc, tRip);
    }
  }, [displayScene]);

  // 卸载清理
  useEffect(() => {
    return () => {
      timersRef.current.forEach(clearTimeout);
    };
  }, []);

  // 顶部资源栏（静态延续）
  const TopBar = (
    <div className="absolute top-0 left-0 right-0 h-[8.8cqh] z-[58] flex items-center px-[2.4cqw] bg-gradient-to-b from-black/30 to-transparent pointer-events-none">
      <div className="flex items-center gap-[1.1cqw]">
        <div className="flex items-center gap-[0.45cqw] rounded-full bg-white/90 px-[1.35cqw] py-[0.25cqh] text-neutral-900 text-[1.65cqw] shadow-sm">
          <span>🪙</span>
          <span className="font-medium tracking-tight">123456</span>
        </div>
        <div className="flex items-center gap-[0.45cqw] rounded-full bg-white/90 px-[1.35cqw] py-[0.25cqh] text-neutral-900 text-[1.65cqw] shadow-sm">
          <span>✨</span>
          <span className="font-medium tracking-tight tabular-nums">999</span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="absolute inset-0 overflow-hidden text-white" style={{ fontSize: 'inherit' }}>
      <style>{`
        @keyframes dustDrift{0%,100%{transform:translate(0,0);opacity:.55}50%{transform:translate(1.8cqw,-2.4cqh);opacity:.82}}
        @keyframes goldFloat{0%{transform:translateY(7cqh)scale(.7);opacity:.88}35%{opacity:.97}100%{transform:translateY(-48cqh)scale(.25);opacity:0}}
        @keyframes seedRise{0%{transform:translateY(38cqh) scale(.72);opacity:.6}52%{transform:translateY(-3.5cqh) scale(1.05);opacity:1}78%{transform:translateY(-7.8cqh) scale(.98);opacity:1}100%{transform:translateY(-7.2cqh) scale(1);opacity:1}}
        @keyframes seedFloat{0%,100%{transform:translateY(-7.2cqh) scale(1)}50%{transform:translateY(-9.6cqh) scale(1.02)}}
        @keyframes seedRoot{0%{transform:translateY(-7.2cqh) scale(1);opacity:1}55%{transform:translateY(11cqh) scale(.64);opacity:.95}100%{transform:translateY(14.5cqh) scale(.42);opacity:.85}}
        @keyframes seedGlow{0%,100%{filter:drop-shadow(0 0 3.5cqw #fde047) brightness(1)}50%{filter:drop-shadow(0 0 7.5cqw #fcd34d) brightness(1.15)}}
        @keyframes cardPop{0%{transform:scale(.58) translateY(1.4cqh);opacity:0}52%{transform:scale(1.04) translateY(-0.6cqh);opacity:1}100%{transform:scale(1) translateY(0);opacity:1}}
        @keyframes cardFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-0.7cqh)}}
        @keyframes ripple{0%{transform:scale(.4);opacity:.75}70%{transform:scale(1.65);opacity:.08}100%{transform:scale(2.1);opacity:0}}
        @keyframes fishSwim{0%,100%{transform:translateX(-7.5cqw)}50%{transform:translateX(8.2cqw)}}
        @keyframes pondBloom{0%{opacity:.0}100%{opacity:.42}}
        @keyframes goldUp{0%{transform:translateY(0) scale(.78);opacity:.92}100%{transform:translateY(-21cqh) scale(.18);opacity:0}}
        @keyframes trail{0%{transform:translateY(0) scale(1);opacity:.85}100%{transform:translateY(-11cqh) scale(.3);opacity:0}}
      `}</style>

      {/* 基底 + 各幕视觉（300ms 过渡层） */}
      <div className="absolute inset-0 transition-opacity duration-[300ms] ease-out" style={{ opacity: sceneOpacity }}>
        {/* 统一生态缸背景（本单元主角） */}
        <SceneImg
          src="/kidshub/boarding/ecopond.png"
          alt="生态缸"
          fallback={
            <div className="absolute inset-0 bg-gradient-to-br from-[#0d2238] via-[#0f4a4a] to-[#3d6b2f]">
              <div className="absolute left-1/2 top-[29%] -translate-x-1/2 rounded-[3.8cqw] bg-[#14b8a6] shadow-[0_0_46px_#14b8a6,0_0_86px_#0f766e] opacity-80" style={{ width: '48cqw', height: '37cqh' }} />
            </div>
          }
        />

        {/* 1. pond-view：全景 + 几条小鱼缓慢左右游动 */}
        {displayScene === 'pond-view' && (
          <>
            {/* 缓慢游动小鱼（translateX 往返） */}
            {[
              { ch: '🐠', l: '19%', t: '41%', d: '0ms', dur: 2850 },
              { ch: '🐟', l: '32%', t: '52%', d: '420ms', dur: 3120 },
              { ch: '🐠', l: '61%', t: '38%', d: '190ms', dur: 2680 },
              { ch: '🐟', l: '73%', t: '49%', d: '610ms', dur: 3290 },
            ].map((f, i) => (
              <div key={i} className="absolute text-[2.15cqw] select-none pointer-events-none" style={{ left: f.l, top: f.t, animation: `fishSwim ${f.dur}ms ease-in-out ${f.d} infinite` }}>{f.ch}</div>
            ))}
            {/* 少量微光粒子 */}
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="absolute h-[0.48cqw] w-[0.48cqw] rounded-full bg-[#fde047]/55 pointer-events-none" style={{ left: `${17 + i * 17}%`, top: `${28 + (i % 2) * 11}%`, animation: `dustDrift ${1950 + i * 310}ms infinite ease-in-out ${i * 130}ms` }} />
            ))}
          </>
        )}

        {/* 2. seed-rise：种子从下方缓缓升至中央 + 金色光环 + 上升轨迹微光粒子（4s） */}
        {(displayScene === 'seed-rise' || displayScene === 'seed-card' || displayScene === 'pond-finale') && (
          <>
            {/* 种子主体（emoji + 光晕） */}
            <div
              className="absolute left-1/2 -translate-x-1/2 z-30 select-none pointer-events-none text-[5.8cqw]"
              style={{
                top: '42%',
                animation: seedPhase === 'rising' ? 'seedRise 2350ms cubic-bezier(0.22,0.9,0.25,1) forwards' : seedPhase === 'floating' ? 'seedFloat 1850ms infinite ease-in-out' : seedPhase === 'rooted' ? 'seedRoot 980ms cubic-bezier(0.32,0.9,0.38,1) forwards' : 'none',
                filter: (seedPhase === 'rising' || seedPhase === 'floating') ? 'drop-shadow(0 0 4.5cqw #fde047) drop-shadow(0 0 9cqw #fcd34d)' : undefined,
              }}
            >
              🌱
            </div>

            {/* 上升/悬浮时的金色光环 + 轨迹粒子 */}
            {(seedPhase === 'rising' || seedPhase === 'floating') && (
              <>
                <div className="absolute left-1/2 -translate-x-1/2 z-20 h-[6.8cqw] w-[6.8cqw] rounded-full border border-yellow-300/50 pointer-events-none" style={{ top: '39.5%', animation: seedPhase === 'floating' ? 'seedFloat 1850ms infinite ease-in-out' : 'seedGlow 980ms infinite ease-in-out' }} />
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="absolute h-[0.38cqw] w-[0.38cqw] rounded-full bg-[#fde047] pointer-events-none z-10" style={{ left: `calc(50% + ${(i - 2.5) * 1.9}cqw)`, top: `${44 + (i % 2) * 2.4}%`, animation: `trail ${920 + i * 85}ms ease-out ${i * 95}ms forwards` }} />
                ))}
              </>
            )}
          </>
        )}

        {/* 3. seed-card：种子旁弹出全息信息卡（teal 描边 + scale-in 轻浮） */}
        {displayScene === 'seed-card' && showCard && (
          <div className="absolute left-[54%] top-[33%] z-40 pointer-events-none" style={{ animation: 'cardPop 420ms cubic-bezier(0.18,0.92,0.3,1.05) forwards, cardFloat 1650ms infinite ease-in-out 420ms' }}>
            <div className="rounded-2xl border border-teal-300/60 bg-black/45 px-[1.65cqw] py-[0.85cqh] shadow-[0_0_0_1px_rgba(52,211,153,.25)]" style={{ width: '31cqw' }}>
              <div className="text-[1.78cqw] font-medium tracking-tight">🌱 启航草 · 方舟第一株绿植</div>
              <div className="mt-[0.15cqh] text-[1.18cqw] text-white/75">陪伴你航行的小伙伴</div>
            </div>
          </div>
        )}

        {/* 4. pond-finale：卡淡出 + 种子落入缸区生根（下移缩小 + 绿光涟漪） + 全画布暖金绿光晕渐亮 + 金粒子上飘 */}
        {displayScene === 'pond-finale' && (
          <>
            {/* 全局温暖金绿光晕 */}
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_58%,rgba(163,230,53,.22)_0%,rgba(52,211,153,.12)_42%,transparent_72%)]" style={{ animation: 'pondBloom 1650ms ease-out forwards' }} />

            {/* 绿光涟漪（种子落定后） */}
            {showRipples && (
              <div className="absolute left-1/2 top-[59%] -translate-x-1/2 z-10 pointer-events-none" style={{ width: '19cqw', height: '11cqh' }}>
                {[0, 1, 2].map((k) => (
                  <div key={k} className="absolute inset-0 rounded-full border border-emerald-300/70" style={{ animation: `ripple 980ms ease-out ${k * 210}ms forwards` }} />
                ))}
              </div>
            )}

            {/* 收尾金粒子上飘（全画布） */}
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="absolute h-[0.52cqw] w-[0.52cqw] rounded-full bg-[#fde047] pointer-events-none z-20" style={{ left: `${18 + ((i * 7.2) % 62)}%`, top: `${29 + (i % 4) * 3.1}%`, animation: `goldUp ${1520 + (i % 5) * 95}ms ease-out forwards ${i * 58}ms`, opacity: 0.78 }} />
            ))}
          </>
        )}
      </div>

      {/* 顶部资源栏 */}
      {TopBar}
    </div>
  );
}
