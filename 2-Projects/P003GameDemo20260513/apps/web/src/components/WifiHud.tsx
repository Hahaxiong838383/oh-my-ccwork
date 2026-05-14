import { useAppStore } from '../store/app-store';

function WifiIcon({ signal }: { signal: 'strong' | 'medium' | 'weak' | 'disconnected' }) {
  const showOuter = signal === 'strong' || signal === 'disconnected';
  const showMiddle = signal === 'strong' || signal === 'medium' || signal === 'disconnected';
  const showInner = signal === 'strong' || signal === 'medium' || signal === 'disconnected';
  const showDot = true;

  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 fill-none"
      aria-hidden
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      {showOuter && <path d="M2.5 8.5C8.2 3.2 15.8 3.2 21.5 8.5" className="stroke-white" />}
      {showMiddle && <path d="M6 12c3.7-3.4 8.3-3.4 12 0" className="stroke-white" />}
      {showInner && <path d="M9.3 15.5c1.7-1.5 3.7-1.5 5.4 0" className="stroke-white" />}
      {showDot && <circle cx="12" cy="19" r={1.6} className="fill-white stroke-none" />}
      {signal === 'disconnected' && <path d="M4 20 20 4" className="stroke-[#ef4444]" />}
    </svg>
  );
}

export function WifiHud() {
  const wifiSignal = useAppStore((s) => s.wifiSignal);

  return (
    <div className="absolute right-12 top-3 z-layer-ui-normal inline-flex h-7 w-8 items-center justify-center rounded-full bg-black/45 ring-1 ring-white/10 backdrop-blur-sm">
      <WifiIcon signal={wifiSignal} />
    </div>
  );
}
