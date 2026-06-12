import { useEffect, useRef, useState } from 'react';
import { useTutorialStore, currentStep } from './tutorial-store';

function SceneImg({ src, alt, fallback }: { src: string; alt: string; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (failed) return <>{fallback}</>;
  return <img src={src} alt={alt} className="absolute inset-0 h-full w-full object-cover" onError={() => setFailed(true)} draggable={false} />;
}

export function NightReportCanvasContent(): JSX.Element {
  const stepIndex = useTutorialStore((s) => s.stepIndex);
  const step = currentStep({ unitId: 'night-report', stepIndex });
  const scene = (step?.scene ?? 'pond-intro') as 'pond-intro' | 'stardust-zone' | 'reward-fly' | 'bonus-chest' | 'wake-word';
  const isStep4 = step?.id === '4';
  const isStep8 = step?.id === '8' || (step?.specStep || '').includes('demo');

  // 幕过渡：与 BoardingCanvasContent 同款 300ms 透明度切场
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

  // 星尘滚动计数（仅 reward-fly 生效，跨 4→5 保持 999）
  const [stardustDisplay, setStardustDisplay] = useState(0);
  const rollRafRef = useRef<number>(0);
  const timersRef = useRef<number[]>([]);
  const hasFlyTriggered = useRef(false);

  // 飞行星星（reward 专用）
  const [flyers, setFlyers] = useState<Array<{ id: number; char: string; left: string; top: string; tx: string; ty: string; anim: string }>>([]);

  // bonus-chest 开箱状态（纯视觉序列）
  const [chestOpen, setChestOpen] = useState(false);
  const [showFlash, setShowFlash] = useState(false);

  function startStardustRoll() {
    window.clearInterval(rollRafRef.current);
    const target = 999;
    const duration = 1450;
    const startTime = performance.now();
    const easeOut = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);
    // setInterval 而非 rAF：后台/无头 webview 会把 rAF 节流到 0Hz，计数会卡 0
    // （feedback_preview_headless_raf_throttle）；计数滚动是状态推进不是帧动画
    rollRafRef.current = window.setInterval(() => {
      const progress = Math.min(1, (performance.now() - startTime) / duration);
      setStardustDisplay(Math.round(target * easeOut(progress)));
      if (progress >= 1) {
        window.clearInterval(rollRafRef.current);
        setStardustDisplay(target);
      }
    }, 33);
  }

  // 场景进入副作用：启动飞行/滚动/开箱序列 + 清理
  useEffect(() => {
    if (displayScene !== 'reward-fly') {
      hasFlyTriggered.current = false;
      setFlyers([]);
    }
    if (displayScene !== 'bonus-chest') {
      setChestOpen(false);
      setShowFlash(false);
    }
    if (displayScene === 'pond-intro' || displayScene === 'stardust-zone') {
      // 进入前两幕时重置星尘显示为 0（reward 后保持 999 直到结束）
      setStardustDisplay(0);
    }

    if (displayScene === 'reward-fly' && isStep4 && !hasFlyTriggered.current) {
      hasFlyTriggered.current = true;
      const tFly = window.setTimeout(() => {
        const chars = ['⭐', '✦', '✨', '🌟', '⭐', '✦', '✨', '🌟', '⭐', '✦'];
        const newFlyers = Array.from({ length: 10 }).map((_, i) => {
          const spread = (i - 4.5) * 1.9 + (i % 2) * 0.8;
          return {
            id: i,
            char: chars[i],
            left: `${46.5 + spread}%`,
            top: `${48.5 + ((i % 3) - 1) * 2.8}%`,
            tx: `${-20.5 + (i % 5 - 2) * 1.6}cqw`,
            ty: `${-38.5 - (i % 3) * 0.6}cqh`,
            anim: `starToBar ${1080 + (i % 3) * 95}ms ease-out ${70 + i * 48}ms forwards`,
          };
        });
        setFlyers(newFlyers);
        // 星星起飞后开始滚动（~1.5s 到 999）
        const tRoll = window.setTimeout(() => startStardustRoll(), 160);
        timersRef.current.push(tRoll);
      }, 190);
      timersRef.current.push(tFly);
    }

    if (displayScene === 'bonus-chest') {
      setChestOpen(false);
      setShowFlash(false);
      const tOpen = window.setTimeout(() => setChestOpen(true), 610);
      const tFlash = window.setTimeout(() => {
        setShowFlash(true);
        const tHide = window.setTimeout(() => setShowFlash(false), 290);
        timersRef.current.push(tHide);
      }, 1040);
      timersRef.current.push(tOpen, tFlash);
    }

    return () => {
      // 步切换时清理，避免旧 raf/定时器串台
    };
  }, [displayScene, isStep4]);

  // 卸载清理
  useEffect(() => {
    return () => {
      window.clearInterval(rollRafRef.current);
      timersRef.current.forEach(clearTimeout);
    };
  }, []);

  // 顶部资源栏（同设置/登舰胶囊风格）：金币固定，星尘在 reward 滚动
  const TopBar = (
    <div className="absolute top-0 left-0 right-0 h-[8.8cqh] z-[58] flex items-center px-[2.4cqw] bg-gradient-to-b from-black/30 to-transparent pointer-events-none">
      <div className="flex items-center gap-[1.1cqw]">
        <div className="flex items-center gap-[0.45cqw] rounded-full bg-white/90 px-[1.35cqw] py-[0.25cqh] text-neutral-900 text-[1.65cqw] shadow-sm">
          <span>🪙</span>
          <span className="font-medium tracking-tight">123456</span>
        </div>
        <div className="flex items-center gap-[0.45cqw] rounded-full bg-white/90 px-[1.35cqw] py-[0.25cqh] text-neutral-900 text-[1.65cqw] shadow-sm">
          <span>✨</span>
          <span className="font-medium tracking-tight tabular-nums">{stardustDisplay}</span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="absolute inset-0 overflow-hidden text-white" style={{ fontSize: 'inherit' }}>
      <style>{`
        @keyframes dustDrift{0%,100%{transform:translate(0,0);opacity:.55}50%{transform:translate(1.8cqw,-2.4cqh);opacity:.82}}
        @keyframes goldFloat{0%{transform:translateY(7cqh)scale(.7);opacity:.88}35%{opacity:.97}100%{transform:translateY(-48cqh)scale(.25);opacity:0}}
        @keyframes pileBreath{0%,100%{transform:scale(1);filter:brightness(1) drop-shadow(0 0 5px rgba(245,158,11,.65))}50%{transform:scale(1.07);filter:brightness(1.18) drop-shadow(0 0 9px rgba(245,158,11,.9))}}
        @keyframes crystalPop{0%{transform:scale(.18) rotate(-14deg);opacity:0}52%{transform:scale(1.16) rotate(7deg);opacity:1}78%{transform:scale(.96) rotate(-2deg);opacity:1}100%{transform:scale(1) rotate(0);opacity:1}}
        @keyframes starToBar{0%{transform:translate(0,0) scale(1);opacity:1}68%{opacity:.92}100%{transform:translate(var(--tx,-20cqw),var(--ty,-38cqh)) scale(.12);opacity:0}}
        @keyframes chestDrop{0%{transform:translateY(-21cqh) scale(.62);opacity:.55}46%{transform:translateY(3.8cqh) scale(1.12)}64%{transform:translateY(-1.6cqh) scale(.95)}100%{transform:translateY(0) scale(1);opacity:1}}
        @keyframes beamRise{0%{opacity:0;transform:scaleY(.25)}55%{opacity:.82}100%{opacity:.55;transform:scaleY(1)}}
        @keyframes popUp{0%{transform:translateY(2.8cqh) scale(.38);opacity:0}22%{opacity:1}100%{transform:translateY(-17cqh) scale(.22);opacity:0}}
        @keyframes flashFade{0%{opacity:.62}100%{opacity:0}}
        @keyframes bubbleSway{0%,100%{transform:translateY(0)}50%{transform:translateY(-1.0cqh)}}
        @keyframes micPulse{0%,100%{transform:scale(.88)}50%{transform:scale(1.18)}}
        @keyframes goldUp{0%{transform:translateY(0) scale(.78);opacity:.92}100%{transform:translateY(-21cqh) scale(.18);opacity:0}}
      `}</style>

      {/* 基底 + 各幕视觉（300ms 过渡层） */}
      <div className="absolute inset-0 transition-opacity duration-[300ms] ease-out" style={{ opacity: sceneOpacity }}>
        {/* 统一生态缸背景（复用登舰 ecopond，温暖金光自然衔接） */}
        <SceneImg
          src="/kidshub/boarding/ecopond.png"
          alt="生态缸"
          fallback={
            <div className="absolute inset-0 bg-gradient-to-br from-[#0d2238] via-[#0f4a4a] to-[#3d6b2f]">
              <div className="absolute left-1/2 top-[29%] -translate-x-1/2 rounded-[3.8cqw] bg-[#14b8a6] shadow-[0_0_46px_#14b8a6,0_0_86px_#0f766e] opacity-80" style={{ width: '48cqw', height: '37cqh' }} />
            </div>
          }
        />

        {/* 1. pond-intro：轻柔氛围 + 缓慢微光粒子 */}
        {displayScene === 'pond-intro' && (
          <>
            <div className="pointer-events-none absolute -top-[16%] left-1/2 h-[42%] w-[66%] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,#fde047_0%,#f59e0b_28%,transparent_70%)] opacity-28" />
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="absolute h-[0.55cqw] w-[0.55cqw] rounded-full bg-[#fde047]/65" style={{ left: `${10 + i * 13.5}%`, top: `${25 + (i % 2) * 13}%`, animation: `dustDrift ${2350 + i * 280}ms infinite ease-in-out ${i * 160}ms` }} />
            ))}
          </>
        )}

        {/* 2. stardust-zone：全屏蒙版 + 左中星尘堆高亮区（无手势、无点击） */}
        {displayScene === 'stardust-zone' && (
          <>
            <div className="absolute inset-0 bg-black/45 pointer-events-none" />
            {/* 星尘展示区：抬 z + ring 高亮 */}
            <div className="absolute pointer-events-none z-40" style={{ left: '8cqw', top: '27cqh' }}>
              <div className="absolute -inset-4 rounded-[2.8cqw] bg-yellow-300/10" />
              <div className="relative ring-2 ring-yellow-300/90 rounded-[2.1cqw] px-[1.4cqw] py-[1.0cqh] bg-white/5">
                {/* 3~5 颗星星叠成小山 + teal/金光晕呼吸 */}
                <div className="relative w-[23cqw] h-[15cqh]">
                  {[
                    { c: '⭐', l: '14%', b: '11%', r: -6, d: '40ms', sz: 1.18 },
                    { c: '✦', l: '37%', b: '19%', r: 11, d: '210ms', sz: 0.96 },
                    { c: '🌟', l: '6%', b: '27%', r: -14, d: '0ms', sz: 1.32 },
                    { c: '✨', l: '55%', b: '7%', r: 4, d: '160ms', sz: 0.88 },
                    { c: '⭐', l: '26%', b: '34%', r: -2, d: '340ms', sz: 1.05 },
                  ].map((s, i) => (
                    <div key={i} className="absolute text-yellow-300 select-none" style={{ left: s.l, bottom: s.b, fontSize: `${3.1 * s.sz}cqw`, transform: `rotate(${s.r}deg)`, animation: `pileBreath 2050ms infinite ease-in-out ${s.d}`, filter: 'drop-shadow(0 0 7px #14b8a6) drop-shadow(0 0 13px #f59e0b)' }}>{s.c}</div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {/* 3. reward-fly：中央大星晶 + X999 + 飞向顶栏星尘胶囊 + 滚动计数 */}
        {displayScene === 'reward-fly' && (
          <>
            {/* step4 中央大特效（蓝紫渐变多角星 + 大计数），step5 时缩小淡出 */}
            {isStep4 && (
              <div className="absolute left-1/2 top-[43%] -translate-x-1/2 -translate-y-1/2 z-30 flex flex-col items-center pointer-events-none" style={{ animation: 'crystalPop 540ms cubic-bezier(0.18,0.92,0.28,1.1) forwards' }}>
                <div className="text-[9.8cqw] leading-none select-none" style={{ background: 'linear-gradient(142deg,#a5b4fc,#c026ff 46%,#6366f1)', WebkitBackgroundClip: 'text', color: 'transparent', filter: 'drop-shadow(0 0 16px rgba(129,140,248,.95)) drop-shadow(0 0 30px rgba(167,139,250,.55))' }}>✦</div>
                <div className="mt-[-0.7cqh] text-[4.9cqw] font-semibold tracking-[0.015em] text-white/95 drop-shadow" style={{ textShadow: '0 0 12px rgba(245,158,11,.55)' }}>✨ ×999</div>
              </div>
            )}
            {/* 8~12 颗小星从中央飞向顶部 ✨ 胶囊（随机延迟+弧线近似+缩小淡出） */}
            {flyers.map((f) => (
              <div key={f.id} className="absolute text-[1.32cqw] pointer-events-none z-20 select-none" style={{ left: f.left, top: f.top, animation: f.anim, '--tx': f.tx, '--ty': f.ty } as any}>{f.char}</div>
            ))}
          </>
        )}

        {/* 4. bonus-chest：宝箱落下轻弹 → 盖子 rotate 弹开 → 金光柱 + 奖励图标弹出散开 + 闪光 */}
        {displayScene === 'bonus-chest' && (
          <>
            {/* 宝箱主体 + 盖子 */}
            <div className="absolute left-1/2 -translate-x-1/2 bottom-[21%] z-30 pointer-events-none" style={{ animation: 'chestDrop 720ms cubic-bezier(0.18,.92,.3,1) forwards' }}>
              <div className="relative" style={{ width: '13.8cqw', height: '10.8cqh' }}>
                {/* 箱体 */}
                <div className="absolute bottom-0 inset-x-[7%] h-[58%] rounded-b-[1.05cqw] bg-gradient-to-b from-amber-700 via-amber-800 to-[#3a271c] border border-amber-900/75 shadow-[inset_0_1.2cqh_2.4cqh_rgba(0,0,0,.35)]" />
                {/* 盖子（开箱时 rotate） */}
                <div className="absolute inset-x-[2%] top-[4%] h-[44%] rounded-t-[1.15cqw] bg-gradient-to-b from-amber-500 to-amber-700 border border-amber-800/70" style={{ transformOrigin: 'center 82%', transform: chestOpen ? 'rotate(-128deg) translateY(-1.9cqh)' : 'rotate(0deg)', transition: chestOpen ? 'transform 255ms cubic-bezier(0.22,1,0.32,1.05)' : 'none', boxShadow: chestOpen ? '0 -1.2cqh 3.2cqh rgba(0,0,0,.32)' : '0 1.6cqh 2.8cqh rgba(0,0,0,.28)' }} />
                {/* 装饰锁/条 */}
                {!chestOpen && <div className="absolute left-1/2 top-[29%] -translate-x-1/2 text-[1.9cqw] text-amber-200/70">🔒</div>}
                <div className="absolute bottom-[34%] inset-x-[11%] h-[1.6px] bg-yellow-900/55" />
              </div>
            </div>

            {/* 开箱后：光柱 + 奖励散开 + 闪光 */}
            {chestOpen && (
              <div className="absolute left-1/2 top-[54%] -translate-x-1/2 z-20 pointer-events-none w-[15cqw]">
                {/* 金色光柱 */}
                <div className="absolute left-1/2 -translate-x-1/2 -mt-[11cqh] h-[15.5cqh] w-[2.9cqw] bg-gradient-to-t from-yellow-300/75 via-amber-200/55 to-transparent rounded-full" style={{ animation: 'beamRise 340ms ease-out forwards' }} />
                {/* 5~6 个小奖励图标向上弹出散开淡出 */}
                {['⭐', '💎', '🌟', '✨', '⭐', '💎'].map((ic, i) => (
                  <div key={i} className="absolute text-[1.7cqw]" style={{ left: `calc(50% + ${(i - 2.5) * 4.1}cqw)`, bottom: '0.4cqh', animation: `popUp ${760 + (i % 3) * 55}ms ease-out ${i * 68 + 55}ms forwards` }}>{ic}</div>
                ))}
              </div>
            )}
            {showFlash && <div className="absolute inset-0 pointer-events-none z-10 bg-[radial-gradient(circle_at_50%_63%,rgba(253,224,71,0.58)_0%,transparent_52%)]" style={{ animation: 'flashFade 270ms linear forwards' }} />}
          </>
        )}

        {/* 5. wake-word：柔和语音提示气泡（step7 喊话提示 / step8 收尾）+ 收尾金粒子 */}
        {displayScene === 'wake-word' && (
          <div className="absolute left-1/2 top-[23%] -translate-x-1/2 z-30 pointer-events-none" style={{ animation: 'bubbleSway 1680ms infinite ease-in-out' }}>
            <div className="rounded-2xl bg-white/86 text-neutral-900 px-[2.15cqw] py-[0.82cqh] text-[1.72cqw] shadow-md flex items-center gap-[0.55cqw]">
              <span className="text-[1.85cqw]" style={{ animation: isStep8 ? 'none' : 'micPulse 1180ms infinite ease-in-out' }}>{isStep8 ? '🎉' : '🎤'}</span>
              <span>{isStep8 ? '🎉 新手之旅完成！' : '试试喊："小可小可"'}</span>
            </div>
          </div>
        )}

        {/* step8 收尾：气泡周围少量金粒子上飘（复用 goldFloat 思路） */}
        {displayScene === 'wake-word' && isStep8 && Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="absolute h-[0.6cqw] w-[0.6cqw] rounded-full bg-[#fde047] pointer-events-none z-20" style={{ left: `${29 + ((i * 8.2) % 42)}%`, top: `${29 + (i % 3) * 2.2}%`, animation: `goldUp ${1580 + (i % 4) * 130}ms ease-out forwards ${i * 75}ms`, opacity: 0.82 }} />
        ))}
      </div>

      {/* 顶部资源栏（所有幕共用，星尘数字在 reward-fly 滚动展示 999） */}
      {TopBar}
    </div>
  );
}
