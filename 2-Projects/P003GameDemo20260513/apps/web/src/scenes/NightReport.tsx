import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { DEMO_DATA } from '../config/demo-data';
import { type BoxLevel, useAppStore } from '../store/app-store';
import { ALL_BOX_LEVELS, BOX_LEVELS } from '../config/boxes';

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
          width: 'clamp(60cqw, 70cqw, 75cqw)',
          // D5 P6：弹窗加高，确保 1-4 个宝箱（PNG 缩略 + 标签）放得下
          height: 'clamp(58cqh, 60cqw, 72cqh)',
          perspective: '1400px',
        }}
      >
        <motion.div
          className="absolute left-[8%] right-[8%] top-[6%] bottom-[18%] overflow-hidden rounded-[clamp(1.2cqh,2cqw,2.4cqh)] bg-amber-50/95 shadow-2xl ring-1 ring-amber-900/10"
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
              padding: 'clamp(2cqh, 3cqw, 4cqh)',
              gap: 'clamp(0.6cqh, 1cqw, 1.2cqh)',
              fontSize: 'clamp(1.4cqh, 2.4cqw, 2.8cqh)',
            }}
          >
            <h2 className="font-semibold tracking-[0.04em]">📜 夜航报告</h2>
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
                      className="flex flex-col items-center justify-center rounded-[clamp(0.6cqh,1cqw,1.2cqh)] px-[clamp(0.35cqh,0.6cqw,0.8cqh)] py-[clamp(0.5cqh,0.8cqw,1cqh)] text-center ring-1"
                      style={{
                        backgroundColor: item.tone,
                        borderColor: 'rgba(110, 74, 36, 0.24)',
                        fontSize: 'clamp(1cqh,1.6cqw,1.9cqh)',
                      }}
                    >
                      <img
                        src={cfg.imageSrc}
                        alt={item.label}
                        draggable={false}
                        style={{
                          width: 'clamp(3.2cqh, 5cqw, 6cqh)',
                          height: 'clamp(3.2cqh, 5cqw, 6cqh)',
                          objectFit: 'contain',
                        }}
                      />
                      <span className="mt-[clamp(0.2cqh,0.3cqw,0.4cqh)] font-medium">{item.label}</span>
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
      </motion.div>
    </div>
  );
}
