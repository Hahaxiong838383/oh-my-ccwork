import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { DEMO_DATA } from '../config/demo-data';
import { type BoxLevel, useAppStore } from '../store/app-store';
import { ALL_BOX_LEVELS, BOX_LEVELS } from '../config/boxes';
import { useTransitionRunner } from '../hooks/useTransitionRunner';

// D5 P7：sayDirect 已收归 applyEffects 默认 TTS，scene 不再重复触发

interface NumberRollProps {
  value: number;
  durationMs: number;
}

function NumberRoll({ value, durationMs }: NumberRollProps) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    let rafId = 0;
    const startedAt = performance.now();

    const easeOut = (t: number) => 1 - (1 - t) * (1 - t) * (1 - t);
    const tick = (now: number) => {
      const elapsed = now - startedAt;
      const progress = Math.min(1, elapsed / durationMs);
      setDisplay(Math.round(value * easeOut(progress)));
      if (progress < 1) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [durationMs, value]);

  return <span className="tabular-nums">{display}</span>;
}

const PHASE_2_AT_MS = 500;
const PHASE_3_AT_MS = 1200;
const EXIT_ANIM_MS = 680;

// D5 P6：宝箱条目用美术 PNG（来自 config/boxes.ts），label/tone 仅用于报告内显示
const BOX_STYLE: Record<BoxLevel, { label: string; tone: string }> = {
  common: { label: '普通', tone: '#d8c5a8' },
  rare: { label: '精品', tone: '#c8b087' },
  epic: { label: '史诗', tone: '#b68e5f' },
  legendary: { label: '传说', tone: '#9e743d' },
};

// D5 P6：每次 nightReport 进入时随机 1-4 个宝箱，每个品质独立随机
function generateRandomBoxes(): BoxLevel[] {
  const count = 1 + Math.floor(Math.random() * 4);
  return Array.from({ length: count }, () =>
    ALL_BOX_LEVELS[Math.floor(Math.random() * ALL_BOX_LEVELS.length)],
  );
}

export function NightReport() {
  const bootState = useAppStore((s) => s.bootState);
  const ecoLevel = useAppStore((s) => s.ecoLevel);
  const bonus = DEMO_DATA.nightReportBonus;
  const isActive = bootState === 'nightReport';
  const { dispatchBoot, dispatchReward } = useTransitionRunner();
  const [phase, setPhase] = useState<1 | 2 | 3>(1);
  const [renderOverlay, setRenderOverlay] = useState(isActive);
  const [isExiting, setIsExiting] = useState(false);
  // D5 P6：每次 isActive 触发时随机生成 1-4 个宝箱，跳出后清空
  const [randomBoxes, setRandomBoxes] = useState<BoxLevel[]>(() =>
    isActive ? generateRandomBoxes() : [],
  );

  // D5 P6/P7：每次 isActive 触发时刷新随机宝箱列表（TTS 已收归 applyEffects）
  useEffect(() => {
    if (!isActive) return;
    setRandomBoxes(generateRandomBoxes());
  }, [isActive]);

  useEffect(() => {
    if (isActive) {
      setRenderOverlay(true);
      setIsExiting(false);
      return;
    }
    if (!renderOverlay) return;
    setIsExiting(true);
    const exitTimer = window.setTimeout(() => {
      setRenderOverlay(false);
      setIsExiting(false);
      setPhase(1);
    }, EXIT_ANIM_MS);
    return () => window.clearTimeout(exitTimer);
  }, [isActive, renderOverlay]);

  useEffect(() => {
    if (!isActive) return;
    setPhase(1);
    const t2 = window.setTimeout(() => setPhase(2), PHASE_2_AT_MS);
    const t3 = window.setTimeout(() => setPhase(3), PHASE_3_AT_MS);
    return () => {
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [isActive]);

  const hasLegendary = useMemo(() => randomBoxes.includes('legendary'), [randomBoxes]);
  const extraUnlocks = useMemo(() => {
    const items: string[] = [];
    if (ecoLevel >= 2) items.push(`灯光鱼缸 Lv${ecoLevel} 可用`);
    if (hasLegendary) items.push('传奇补给权限已激活');
    return items;
  }, [ecoLevel, hasLegendary]);

  if (!renderOverlay) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-layer-modal flex items-center justify-center"
      style={{ containerType: 'size' }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0, y: '100%' }}
        animate={
          isExiting
            ? { opacity: 0, scale: 0.9, y: '88%' }
            : { opacity: 1, scale: 1, y: '0%' }
        }
        transition={{
          duration: isExiting ? EXIT_ANIM_MS / 1000 : 0.5,
          ease: [0.22, 1, 0.36, 1],
        }}
        className="relative"
        style={{
          // D6 P4：川哥反馈"夜航报告界面过小看不清"，整体放大：
          // width 70 → 88cqw / height 60 → 80cqw（高度跟随宽度 ratio 提）
          width: 'clamp(78cqw, 88cqw, 92cqw)',
          height: 'clamp(72cqh, 80cqw, 88cqh)',
          perspective: '1400px',
        }}
      >
        {/* D6 P5：川哥反馈"新解锁文字没显示全"。信纸 bottom 22→6%（吃满弹窗），
            收取奖励按钮挪到信纸内右上角（与"📜 夜航报告"标题顶对齐）。 */}
        <motion.div
          className="absolute left-[6%] right-[6%] top-[5%] bottom-[6%] overflow-hidden rounded-[clamp(1.2cqh,2cqw,2.4cqh)] bg-amber-50/95 shadow-2xl ring-1 ring-amber-900/10"
          animate={
            isExiting
              ? { y: '100%', opacity: 0.8, scale: 0.98 }
              : { y: phase >= 3 ? '0%' : '100%', opacity: phase >= 3 ? 1 : 0.82, scale: 1 }
          }
          transition={{
            duration: isExiting ? 0.42 : 0.8,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          <div
            className="flex h-full flex-col"
            style={{
              color: '#5b3b1f',
              padding: 'clamp(2.6cqh, 4cqw, 5.2cqh)',
              gap: 'clamp(0.9cqh, 1.4cqw, 1.8cqh)',
              fontSize: 'clamp(2cqh, 3.4cqw, 4cqh)',
            }}
          >
            {/* D6 P6：h2 + 收取奖励按钮放 flex row，按钮 inline 右对齐避开 h2 文字 */}
            <div className="flex items-center justify-between gap-[clamp(1cqh,2cqw,2.4cqh)]">
              <h2 className="font-semibold tracking-[0.04em]">📜 夜航报告</h2>
              {phase >= 3 && !isExiting && (
                <motion.button
                  type="button"
                  onClick={() => {
                    if (isExiting) return;
                    // D6 P6：触发开宝箱体验 — 从 randomBoxes 抽最高品质，
                    // dispatchReward 进 openingBox（OpenBox scene 自动覆盖渲染），
                    // 同步 dispatchBoot 切 askMode，开完箱后自然落在状态询问页。
                    if (randomBoxes.length > 0) {
                      let best = randomBoxes[0];
                      let bestIdx = ALL_BOX_LEVELS.indexOf(best);
                      for (const b of randomBoxes) {
                        const i = ALL_BOX_LEVELS.indexOf(b);
                        if (i > bestIdx) { best = b; bestIdx = i; }
                      }
                      dispatchReward({ type: 'OPEN_BOX', level: best });
                    }
                    dispatchBoot({ type: 'NIGHT_REPORT_DONE' });
                  }}
                  className="shrink-0 cursor-pointer rounded-full bg-amber-400 font-bold text-amber-900 shadow-[0_0_2.4cqh_rgba(255,180,40,0.6)] ring-2 ring-amber-300/80 transition active:scale-95 hover:brightness-110"
                  style={{
                    paddingBlock: 'clamp(1.6cqh, 2.6cqw, 3.2cqh)',
                    paddingInline: 'clamp(3.4cqh, 5cqw, 6cqh)',
                    fontSize: 'clamp(1.9cqh, 3.2cqw, 3.8cqh)',
                    letterSpacing: '0.06em',
                  }}
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                >
                  🎁 收取奖励
                </motion.button>
              )}
            </div>
            <p className="font-medium">
              星尘奖励 +<NumberRoll value={bonus.stardust} durationMs={1300} />
            </p>
            <p className="font-medium">家族币 +{bonus.familyCoin}</p>

            <div className="mt-[clamp(0.3cqh,0.6cqw,0.8cqh)]">
              <p className="mb-[clamp(0.3cqh,0.5cqw,0.6cqh)] font-semibold">
                已开宝箱 <span className="opacity-60">×{randomBoxes.length}</span>
              </p>
              {/* D5 P6：列数 = 宝箱数（1-4），cell 居中、缩小 PNG 适配 */}
              <div
                className="grid gap-[clamp(0.4cqh,0.7cqw,0.9cqh)]"
                style={{
                  gridTemplateColumns: `repeat(${Math.max(1, randomBoxes.length)}, minmax(0, 1fr))`,
                }}
              >
                {randomBoxes.map((level, idx) => {
                  const item = BOX_STYLE[level];
                  const cfg = BOX_LEVELS[level];
                  return (
                    <div
                      key={`${level}-${idx}`}
                      className="flex flex-col items-center justify-center rounded-[clamp(0.8cqh,1.4cqw,1.7cqh)] px-[clamp(0.5cqh,0.9cqw,1.2cqh)] py-[clamp(0.7cqh,1.2cqw,1.5cqh)] text-center ring-1"
                      style={{
                        backgroundColor: item.tone,
                        borderColor: 'rgba(110, 74, 36, 0.24)',
                        fontSize: 'clamp(1.5cqh,2.4cqw,2.8cqh)',
                      }}
                    >
                      <img
                        src={cfg.imageSrc}
                        alt={item.label}
                        draggable={false}
                        style={{
                          width: 'clamp(4.5cqh, 7cqw, 8.5cqh)',
                          height: 'clamp(4.5cqh, 7cqw, 8.5cqh)',
                          objectFit: 'contain',
                        }}
                      />
                      <span className="mt-[clamp(0.3cqh,0.5cqw,0.7cqh)] font-medium">{item.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {extraUnlocks.length > 0 && (
              <div className="mt-[clamp(0.25cqh,0.4cqw,0.6cqh)]">
                <p className="font-semibold">新解锁</p>
                <ul className="mt-[clamp(0.2cqh,0.4cqw,0.5cqh)] space-y-[clamp(0.1cqh,0.2cqw,0.3cqh)]">
                  {extraUnlocks.map((line) => (
                    <li key={line}>• {line}</li>
                  ))}
                </ul>
              </div>
            )}

            <p className="mt-auto opacity-80">指挥官，明早见</p>
          </div>
        </motion.div>

        {/* D5 P5：川哥要求去掉信封身和封口三角（视觉上像上下箭头），只保留信纸 */}
        {/* D6 P6：收取奖励按钮已挪到信纸内 h2 同行右侧（flex row），不再外部 absolute */}
      </motion.div>
    </div>
  );
}
