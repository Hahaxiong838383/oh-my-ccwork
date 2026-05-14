import { useMemo } from 'react';
import { useCountdown } from '../hooks/useCountdown';

interface CountdownRingProps {
  seconds?: number;
  active?: boolean;
  onTimeout?: () => void;
  label?: string;
  size?: number;
}

export function CountdownRing({
  seconds = 30,
  active = true,
  onTimeout,
  label = '倒计时',
  size = 80,
}: CountdownRingProps) {
  const { remainingSeconds, progress } = useCountdown({ seconds, active, onTimeout });

  const { radius, circumference, dashOffset } = useMemo(() => {
    const strokeWidth = 6;
    const circleRadius = size / 2 - strokeWidth;
    const circleCircumference = 2 * Math.PI * circleRadius;
    const clampedProgress = Math.min(1, Math.max(0, progress));
    return {
      radius: circleRadius,
      circumference: circleCircumference,
      dashOffset: circleCircumference * (1 - clampedProgress),
    };
  }, [progress, size]);

  return (
    <div
      className="relative inline-flex items-center justify-center text-white"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="h-full w-full -rotate-90"
        aria-hidden
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          className="stroke-white/15"
          fill="none"
          strokeWidth="6"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          className="stroke-current text-porthole-glow transition-[stroke-dashoffset] duration-100"
          fill="none"
          strokeWidth="6"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
        />
      </svg>

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-xl font-semibold tabular-nums leading-none">{remainingSeconds}</div>
        <div className="mt-1 text-[10px] text-white/70">{label}</div>
      </div>
    </div>
  );
}
