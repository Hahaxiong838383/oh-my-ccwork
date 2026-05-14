/**
 * P003 场景美术化模板 · V1.0
 *
 * 用法：复制本文件到 apps/web/src/scenes/<SceneName>.tsx，
 * 替换 6 处 ⚠️ TODO 标记的参数即可。
 *
 * 已实施案例：
 * - apps/web/src/scenes/Welcome.tsx
 * - apps/web/src/scenes/AskMode.tsx（带按钮 hit area）
 * - apps/web/src/scenes/SetupGuide.tsx（带视频过渡）
 */
import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/app-store';
import { getSharedVoiceClient } from '../services/voice-client';

// ⚠️ TODO 1：图资产路径
const SCENE_BG = '/assets/<scene>-bg.png';

// ⚠️ TODO 2：TTS 开口文案（≤30 字日常 / ≤500 字故事，按场景定）
const SCENE_LINE = '<开机文案>';

function getVoiceWsUrl(): string {
  const envUrl = import.meta.env.VITE_VOICE_WS_URL as string | undefined;
  if (envUrl && envUrl.trim()) return envUrl;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws/voice`;
}

interface StarSpec {
  id: string;
  left: string;
  top: string;
  size: string;
  delay: string;
  duration: string;
  drift: string;
}

// ⚠️ TODO 3：星点位置（仅放图里"舷窗"范围内）
// 参数：drift 3-4cqw / duration 3-3.8s / 负延迟错相位
const STARS: readonly StarSpec[] = [
  { id: 's1', left: '14cqw', top: '14cqh', size: '0.9cqw', delay: '-0.4s', duration: '3.4s', drift: '2.5cqw' },
  { id: 's2', left: '22cqw', top: '24cqh', size: '0.6cqw', delay: '-1.8s', duration: '3.0s', drift: '-2.0cqw' },
  { id: 's3', left: '26cqw', top: '9cqh', size: '0.8cqw', delay: '-2.6s', duration: '3.6s', drift: '1.8cqw' },
  { id: 's4', left: '8cqw', top: '38cqh', size: '0.7cqw', delay: '-1.0s', duration: '3.2s', drift: '2.2cqw' },
  { id: 's5', left: '24cqw', top: '20cqh', size: '0.6cqw', delay: '-3.0s', duration: '3.8s', drift: '-1.6cqw' },
];

export function SceneTemplate() {
  // ⚠️ TODO 4：场景激活条件（替换为该场景的 store selector）
  const isActive = useAppStore((s) => s.bootState === '<sceneId>');
  const spokenRef = useRef(false);

  // ⚠️ Rules of Hooks: useEffect 必须在 early return 之前
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
        console.warn('[<scene>] voice ws connect failed', err);
        return;
      }
      client.sayDirect(SCENE_LINE);
    })();
  }, [isActive]);

  if (!isActive) return null;

  return (
    <div
      className="absolute inset-0 z-layer-mask overflow-hidden"
      style={{ containerType: 'size', isolation: 'isolate' }}
    >
      <img
        src={SCENE_BG}
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        draggable={false}
      />

      {/* 星点层：clipPath 椭圆裁剪到舷窗范围 */}
      {/* ⚠️ TODO 5：椭圆参数 (rx ry at cx cy) 对齐图里舷窗形状 */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          clipPath: 'ellipse(42% 36% at 50% 32%)',
          WebkitClipPath: 'ellipse(42% 36% at 50% 32%)',
        }}
        aria-hidden
      >
        {STARS.map((star) => {
          const styleVars = { '--star-drift': star.drift } as React.CSSProperties;
          return (
            <span
              key={star.id}
              className="absolute rounded-full bg-white"
              style={{
                left: star.left,
                top: star.top,
                width: star.size,
                height: star.size,
                ...styleVars,
                animation: `scene-star-drift ${star.duration} ease-in-out ${star.delay} infinite both`,
                boxShadow: '0 0 5px rgba(255,255,255,0.85)',
              }}
            />
          );
        })}
      </div>

      {/* 表情屏绿光呼吸 */}
      {/* ⚠️ TODO 6：left/top/width/height 对齐图里小可表情屏中心 */}
      <div
        className="scene-eye-glow pointer-events-none absolute rounded-full"
        style={{
          left: '46cqw',
          top: '34cqh',
          width: '14cqw',
          height: '11cqh',
          background:
            'radial-gradient(ellipse at center, rgba(110,255,170,0.85) 0%, rgba(110,255,170,0.3) 40%, transparent 70%)',
          filter: 'blur(2.4cqh)',
          animation: 'scene-eye-glow 1.8s ease-in-out infinite',
        }}
        aria-hidden
      />

      {/* （可选）按钮 hit area：透明 button 叠在 PNG 按钮位置上 */}
      {/* 例：
        <button
          type="button"
          onClick={() => dispatchXxx(...)}
          aria-label="<button label>"
          className="absolute cursor-pointer rounded-2xl border-0 bg-transparent transition-transform active:scale-95"
          style={{ left: '4cqw', top: '75cqh', width: '40cqw', height: '18cqh' }}
        />
      */}

      {/* （可选）字幕条：仅当 PNG 无字幕时启用，参考 Welcome.tsx 实现 */}

      <style>{`
        @keyframes scene-star-drift {
          0%, 100% { transform: translateX(0) scale(0.65); opacity: 0.25; }
          50% { transform: translateX(var(--star-drift)) scale(1.25); opacity: 1; }
        }
        .scene-eye-glow {
          mix-blend-mode: screen;
        }
        @supports not (mix-blend-mode: screen) {
          .scene-eye-glow {
            mix-blend-mode: normal;
            opacity: 0.5;
          }
        }
        @keyframes scene-eye-glow {
          0%, 100% { opacity: 0.25; transform: scale(0.9); }
          50% { opacity: 0.85; transform: scale(1.12); }
        }
      `}</style>
    </div>
  );
}
