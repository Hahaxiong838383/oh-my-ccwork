import { useUserStore } from '../store/user-store';
import { useSettingsStore } from '../store/settings-store';
import { formatNumber } from '../systems/number-format';

/**
 * 顶栏（z=40 普通模式静态 UI）
 *
 * 内容：星尘 + 家族币双货币胶囊 + WiFi 状态 + 设置按钮
 * 数字 ≥1M 显示为 "X K+"（规则见 1.6 主界面）
 */
export function TopBar() {
  const stardust = useUserStore((s) => s.stardust);
  const familyCoin = useUserStore((s) => s.familyCoin);

  return (
    <div className="flex items-start justify-between px-4 py-2 text-[11px]">
      <div className="flex gap-2">
        <CoinCapsule label="星尘" value={stardust} color="text-stardust" dotColor="bg-stardust" />
        <CoinCapsule label="家族币" value={familyCoin} color="text-family-coin" dotColor="bg-family-coin" />
      </div>
      <div className="flex items-center gap-2">
        <WifiIcon />
        <SettingsButton />
      </div>
    </div>
  );
}

function CoinCapsule({
  value,
  color,
  dotColor,
}: {
  label: string;
  value: number;
  color: string;
  dotColor: string;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-full bg-black/40 px-2.5 py-1 backdrop-blur-sm">
      <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
      <span className={`font-medium ${color}`}>{formatNumber(value)}</span>
    </div>
  );
}

function WifiIcon() {
  return (
    <div className="flex h-5 w-5 items-center justify-center rounded-full bg-black/40 text-[9px] text-white/60 backdrop-blur-sm">
      WIFI
    </div>
  );
}

function SettingsButton() {
  const cycle = useSettingsStore((s) => s.cycleBrightness);
  return (
    <button
      onClick={cycle}
      className="flex h-5 w-5 items-center justify-center rounded-full bg-black/40 text-xs text-white/60 backdrop-blur-sm active:scale-95"
      aria-label="设置"
    >
      ⚙
    </button>
  );
}
