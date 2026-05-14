import { useEffect, useState } from 'react';
import { SCENE_KEYBOARD_MAP, SCENE_LABELS, SCENE_ORDER } from '../machines/jump-to-scene';
import { jumpToScene } from '../machines';
import { useTransitionRunner } from '../hooks/useTransitionRunner';
import { useAppStore, type SceneId } from '../store/app-store';

const MAIN_FLOW_SCENES: SceneId[] = ['welcome', 'nightReport', 'askMode', 'focusRunning'];
const OPEN_BOX_SCENES: SceneId[] = ['boxCommon', 'boxRare', 'boxEpic', 'boxLegendary'];
const OTHER_SCENES: SceneId[] = ['ecoUnlock', 'farewell'];

export function DebugBar() {
  const setupComplete = useAppStore((s) => s.setupComplete);
  const wifiSignal = useAppStore((s) => s.wifiSignal);
  const [sceneValue, setSceneValue] = useState<SceneId | ''>('');
  const { dispatchBoot } = useTransitionRunner();

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
            useAppStore.getState().setSetupComplete(true);
            dispatchBoot({ type: 'SETUP_DONE' });
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
    </div>
  );
}
