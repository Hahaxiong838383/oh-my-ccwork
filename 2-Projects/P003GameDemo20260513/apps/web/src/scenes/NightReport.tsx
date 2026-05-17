import { motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DEMO_DATA } from '../config/demo-data';
import { type BoxLevel, useAppStore } from '../store/app-store';
import { getSharedVoiceClient } from '../services/voice-client';

const NIGHT_REPORT_LINE = '夜航报告出炉，这是你不在的时候我去赚来的哦！';

function getVoiceWsUrl(): string {
  const envUrl = import.meta.env.VITE_VOICE_WS_URL as string | undefined;
  if (envUrl && envUrl.trim()) return envUrl;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws/voice`;
}

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
const BOX_ORDER: BoxLevel[] = ['common', 'rare', 'epic', 'legendary'];

const BOX_STYLE: Record<BoxLevel, { label: string; icon: string; tone: string }> = {
  common: { label: '普通', icon: '📦', tone: '#d8c5a8' },
  rare: { label: '精品', icon: '🎁', tone: '#c8b087' },
  epic: { label: '史诗', icon: '💎', tone: '#b68e5f' },
  legendary: { label: '传说', icon: '👑', tone: '#9e743d' },
};

export function NightReport() {
  const bootState = useAppStore((s) => s.bootState);
  const openedBoxLevels = useAppStore((s) => s.openedBoxLevels);
  const ecoLevel = useAppStore((s) => s.ecoLevel);
  const bonus = DEMO_DATA.nightReportBonus;
  const isActive = bootState === 'nightReport';
  const [phase, setPhase] = useState<1 | 2 | 3>(1);
  const [renderOverlay, setRenderOverlay] = useState(isActive);
  const [isExiting, setIsExiting] = useState(false);
  const spokenRef = useRef(false);

  // D5 P5：nightReport 出现时小可开口 TTS
  useEffect(() => {
    if (!isActive) {
      spokenRef.current = false;
      return;
    }
    if (spokenRef.current) return;
    spokenRef.current = true;
    const client = getSharedVoiceClient();
    void (async () => {
      try {
        await client.connect(getVoiceWsUrl());
      } catch (err) {
        console.warn('[NightReport] voice ws connect failed', err);
        return;
      }
      client.sayDirect(NIGHT_REPORT_LINE);
    })();
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

  const openedSet = useMemo(() => new Set(openedBoxLevels), [openedBoxLevels]);
  const extraUnlocks = useMemo(() => {
    const items: string[] = [];
    if (ecoLevel >= 2) items.push(`灯光鱼缸 Lv${ecoLevel} 可用`);
    if (openedSet.has('legendary')) items.push('传奇补给权限已激活');
    return items;
  }, [ecoLevel, openedSet]);

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
          height: 'clamp(33cqh, 40cqw, 37cqh)',
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
              <p className="mb-[clamp(0.3cqh,0.5cqw,0.6cqh)] font-semibold">已开宝箱</p>
              <div className="grid grid-cols-4 gap-[clamp(0.4cqh,0.7cqw,0.9cqh)]">
                {BOX_ORDER.map((level) => {
                  const item = BOX_STYLE[level];
                  const active = openedSet.has(level);
                  return (
                    <div
                      key={level}
                      className="flex flex-col items-center justify-center rounded-[clamp(0.6cqh,1cqw,1.2cqh)] px-[clamp(0.35cqh,0.6cqw,0.8cqh)] py-[clamp(0.35cqh,0.6cqw,0.8cqh)] text-center ring-1"
                      style={{
                        backgroundColor: active ? item.tone : 'rgba(255,248,226,0.45)',
                        opacity: active ? 1 : 0.55,
                        borderColor: 'rgba(110, 74, 36, 0.24)',
                        fontSize: 'clamp(1cqh,1.6cqw,1.9cqh)',
                      }}
                    >
                      <span aria-hidden>{item.icon}</span>
                      <span className="mt-[clamp(0.1cqh,0.2cqw,0.3cqh)]">{item.label}</span>
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
