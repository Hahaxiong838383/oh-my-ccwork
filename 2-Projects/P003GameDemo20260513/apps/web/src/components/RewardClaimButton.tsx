import { useAppStore } from '../store/app-store';
import { useTransitionRunner } from '../hooks/useTransitionRunner';

/**
 * RewardClaimButton —— 「收获奖励」可点击覆盖按钮（D5 P24 / D6 P2 修订）
 *
 * D6 P2：focusStage='openable' 或 'full' 时显示（即美术"变黄"起就能点）。
 * 川哥反馈"只要变黄了就可以点击获取"——openable 阈值在 deriveFocusStage
 * 是 progress ≥ 60%，'full' 是 ≥ 95%。
 * 位置：覆盖背景图 07-full.png / 06-openable.png 美术里画好的"收获奖励"按钮（约画面中下，
 * 离底约 22-32%，居中，宽 35% / 高 14%）。透明 button，依赖美术视觉。
 */
export function RewardClaimButton() {
  const focusMachine = useAppStore((s) => s.focusMachine);
  const focusStage = useAppStore((s) => s.focusStage);
  const { dispatchFocus } = useTransitionRunner();

  if (focusMachine !== 'running') return null;
  if (focusStage !== 'openable' && focusStage !== 'full') return null;

  return (
    <button
      type="button"
      onClick={() => dispatchFocus({ type: 'FOCUS_REWARD_READY' })}
      className="absolute z-layer-ui-focus cursor-pointer rounded-full border-0 bg-transparent transition-transform active:scale-95"
      aria-label="收获奖励"
      style={{
        left: '50%',
        top: '74%',
        transform: 'translate(-50%, -50%)',
        width: '38%',
        height: '15%',
      }}
    />
  );
}
