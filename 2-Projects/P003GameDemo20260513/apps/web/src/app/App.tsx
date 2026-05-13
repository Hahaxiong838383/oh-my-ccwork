import { useEffect, useState } from 'react';
import { OnboardingScene } from '../scenes/Onboarding';
import { MainScene } from '../scenes/Main';
import { useAppStore } from '../store/app-store';

export function App() {
  const [ready, setReady] = useState(false);
  const onboarded = useAppStore((s) => s.onboarded);

  useEffect(() => {
    // 占位：未来在这里 hydrate Dexie -> Zustand
    setReady(true);
  }, []);

  if (!ready) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-porthole-bg">
        <div className="text-porthole-glow text-sm tracking-widest">KEEPING WARM…</div>
      </div>
    );
  }

  return onboarded ? <MainScene /> : <OnboardingScene />;
}
