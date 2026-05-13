/**
 * LED 指示灯 —— 跟随 settings store 实时反映亮度/色温/开关
 * 用 box-shadow 模拟真实灯光的"溢出感"
 */
const COLOR_TEMPS = {
  1: '#fff5e0', // 常规 / 暖光1
  2: '#f5d9a0', // 绘画 / 暖光2
  3: '#e8b87a', // 夜读
} as const;

const BRIGHTNESS_INTENSITY = {
  1: 0.4,
  2: 0.7,
  3: 1.0,
} as const;

export function LEDIndicator({
  on,
  brightness,
  colorTemp,
}: {
  on: boolean;
  brightness: 1 | 2 | 3;
  colorTemp: 1 | 2 | 3;
}) {
  const color = on ? COLOR_TEMPS[colorTemp] : '#3a4051';
  const intensity = on ? BRIGHTNESS_INTENSITY[brightness] : 0;

  return (
    <div
      className="h-3 w-3 rounded-full transition-all duration-300"
      style={{
        backgroundColor: color,
        boxShadow: on
          ? `0 0 ${12 * intensity}px ${4 * intensity}px ${color}, 0 0 ${24 * intensity}px ${8 * intensity}px ${color}80`
          : 'none',
        opacity: on ? 0.85 + intensity * 0.15 : 0.4,
      }}
    />
  );
}
