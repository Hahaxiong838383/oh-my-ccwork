import { useEffect, useState } from 'react';
import { SCENE_KEYBOARD_MAP, SCENE_LABELS, SCENE_ORDER } from '../machines/jump-to-scene';
import { jumpToScene } from '../machines';
import { useTransitionRunner } from '../hooks/useTransitionRunner';
import { useAppStore, type SceneId } from '../store/app-store';
import { getSharedVoiceClient } from '../services/voice-client';
import { requestCameraPermissionAndSnap } from '../services/expression-snapshot';

function getVoiceWsUrl(): string {
  const envUrl = import.meta.env.VITE_VOICE_WS_URL as string | undefined;
  if (envUrl && envUrl.trim()) return envUrl;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws/voice`;
}

const MAIN_FLOW_SCENES: SceneId[] = ['welcome', 'nightReport', 'askMode', 'focusRunning', 'focusCompanion'];
const OPEN_BOX_SCENES: SceneId[] = ['boxCommon', 'boxRare', 'boxEpic', 'boxLegendary'];
const OTHER_SCENES: SceneId[] = ['ecoUnlock', 'farewell'];

export function DebugBar() {
  const setupComplete = useAppStore((s) => s.setupComplete);
  const wifiSignal = useAppStore((s) => s.wifiSignal);
  const focusMachine = useAppStore((s) => s.focusMachine);
  const rewardMachine = useAppStore((s) => s.rewardMachine);
  const focusStageDurationMs = useAppStore((s) => s.focusStageDurationMs);
  const ecoLevel = useAppStore((s) => s.ecoLevel);
  const [sceneValue, setSceneValue] = useState<SceneId | ''>('');
  const [progressStart, setProgressStart] = useState<string>('');
  const { dispatchBoot, dispatchFocus } = useTransitionRunner();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const scene = SCENE_KEYBOARD_MAP[event.key];
      if (!scene) return;
      jumpToScene(scene);
      setSceneValue(scene);
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const debugInputClass =
    'h-6 rounded border border-white/20 bg-shell-bg px-2 text-[10px] text-white outline-none ring-0 transition focus:border-porthole-glow';
  const labelClass = 'w-10 shrink-0 text-right text-[10px] text-white/70';
  const activeClass = 'ring-1 ring-porthole-glow font-semibold text-white';

  return (
    <div className="rounded-md border border-shell-trim bg-shell-bg/90 px-2 py-2 text-[10px] text-white/85">
      <div className="flex items-center gap-2">
        <span className={labelClass}>配网：</span>
        <button
          type="button"
          onClick={() => {
            useAppStore.getState().setSetupComplete(false);
            dispatchBoot({ type: 'SETUP_RESET' });
          }}
          className={`h-6 rounded border border-white/15 px-2 text-[10px] transition hover:bg-white/10 ${
            !setupComplete ? activeClass : ''
          }`}
        >
          📵 未配网
        </button>
        <button
          type="button"
          onClick={() => {
            const client = getSharedVoiceClient();
            // 用户手势栈内：提前解锁 AudioContext + 预连 ws，
            // 让 Welcome 后续 sayDirect 能直接播音
            void client.unlockAudio();
            void client.connect(getVoiceWsUrl()).catch((err) => {
              console.warn('[DebugBar] ws pre-connect failed', err);
            });
            void requestCameraPermissionAndSnap();
            const store = useAppStore.getState();
            if (store.bootState === 'unconfigured') {
              store.setSetupVideoRequested(true);
            } else {
              store.setSetupComplete(true);
              dispatchBoot({ type: 'SETUP_DONE' });
            }
          }}
          className={`h-6 rounded border border-white/15 px-2 text-[10px] transition hover:bg-white/10 ${
            setupComplete ? activeClass : ''
          }`}
        >
          ✅ 完成配网
        </button>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className={labelClass}>WiFi：</span>
        <select
          value={wifiSignal}
          onChange={(event) =>
            useAppStore.getState().setWifiSignal(event.target.value as typeof wifiSignal)
          }
          className={`${debugInputClass} min-w-[140px]`}
          aria-label="WiFi 信号"
        >
          <option value="strong">strong</option>
          <option value="medium">medium</option>
          <option value="weak">weak</option>
          <option value="disconnected">disconnected</option>
        </select>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className={labelClass}>跳关：</span>
        <select
          value={sceneValue}
          onChange={(event) => {
            const nextScene = event.target.value as SceneId | '';
            setSceneValue(nextScene);
            if (!nextScene) return;
            jumpToScene(nextScene);
          }}
          className={`${debugInputClass} min-w-[220px]`}
          aria-label="跳关选择"
        >
          <option value="">选择剧情...</option>
          <optgroup label="主流程">
            {SCENE_ORDER.filter((scene) => MAIN_FLOW_SCENES.includes(scene)).map((scene) => (
              <option key={scene} value={scene}>
                {SCENE_LABELS[scene]}
              </option>
            ))}
          </optgroup>
          <optgroup label="开宝箱">
            {SCENE_ORDER.filter((scene) => OPEN_BOX_SCENES.includes(scene)).map((scene) => (
              <option key={scene} value={scene}>
                {SCENE_LABELS[scene]}
              </option>
            ))}
          </optgroup>
          <optgroup label="其他">
            {SCENE_ORDER.filter((scene) => OTHER_SCENES.includes(scene)).map((scene) => (
              <option key={scene} value={scene}>
                {SCENE_LABELS[scene]}
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      {focusMachine === 'idle' && (
        <div className="mt-2 flex items-center gap-2">
          <span className={labelClass}>过渡：</span>
          <button
            type="button"
            onClick={() => {
              jumpToScene('askMode');
              dispatchFocus({ type: 'LAUNCH', mode: 'explore' });
            }}
            className="h-6 rounded border border-white/15 px-2 text-[10px] transition hover:bg-white/10"
          >
            ▶ 演示出航过渡
          </button>
          <button
            type="button"
            onClick={() => {
              jumpToScene('askMode');
              dispatchFocus({ type: 'LAUNCH', mode: 'companion' });
            }}
            className="h-6 rounded border border-white/15 px-2 text-[10px] transition hover:bg-white/10"
          >
            ▶ 演示静思过渡
          </button>
        </div>
      )}

      {focusMachine === 'idle' && (rewardMachine === 'idle' || rewardMachine === 'ecoUnlock') && (
        <div className="mt-2 flex items-center gap-2">
          <span className={labelClass}>生态缸：</span>
          {([
            { level: 1, label: '🌱 Lv1' },
            { level: 2, label: '🌿 Lv2' },
            { level: 3, label: '🌳 Lv3' },
            { level: 4, label: '✨ Lv4' },
          ] as const).map(({ level, label }) => (
            <button
              key={level}
              type="button"
              onClick={() => {
                const store = useAppStore.getState();
                store.setEcoLevel(level);
                jumpToScene('ecoUnlock');
              }}
              className={`h-6 rounded border border-white/15 px-2 text-[10px] transition hover:bg-white/10 ${
                ecoLevel === level ? activeClass : ''
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {focusMachine !== 'idle' && (
        <>
          {/* D5 P8：原"速度"slider 改为"切图间隔"，复用位置驱动 focus 4 阶段轮换 + 进度条 */}
          <div className="mt-2 flex items-center gap-2">
            <span className={labelClass}>切图间隔：</span>
            <input
              type="range"
              min="500"
              max="5000"
              step="100"
              value={focusStageDurationMs}
              onChange={(event) => {
                useAppStore.getState().setFocusStageDurationMs(Number(event.target.value));
              }}
              className="h-6 min-w-[170px]"
              aria-label="专注切图间隔"
            />
            <span className="min-w-[42px] text-[10px] text-white/75">{(focusStageDurationMs / 1000).toFixed(1)}s</span>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <span className={labelClass}>进度：</span>
            <input
              type="number"
              min="0"
              max="100"
              step="5"
              value={progressStart}
              onChange={(event) => setProgressStart(event.target.value)}
              placeholder="进度%"
              className={`${debugInputClass} w-[88px]`}
              aria-label="专注进度起点"
            />
            <button
              type="button"
              onClick={() => {
                const rawValue = Number(progressStart);
                if (!Number.isFinite(rawValue)) return;
                const progress = Math.max(0, Math.min(100, rawValue));
                // D5 P8：jumpProgress 时根据 focusStageDurationMs * 4 反推 startedAt
                const cycleMs = focusStageDurationMs * 4;
                const startedAt = Date.now() - (progress / 100) * cycleMs;
                const store = useAppStore.getState();
                store.setFocusProgress(progress);
                store.setFocusStartedAt(startedAt);
              }}
              className="h-6 rounded border border-white/15 px-2 text-[10px] transition hover:bg-white/10"
            >
              跳到
            </button>
            {focusMachine === 'running' ? (
              <button
                type="button"
                onClick={() => {
                  useAppStore.getState().setFocusProgress(100);
                }}
                className="h-6 rounded border border-white/15 px-2 text-[10px] transition hover:bg-white/10"
              >
                ⏩ 一键满进度
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
