/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 设备外壳 —— 工业设计感
        'shell-bg': '#0f1115',
        'shell-frame': '#1e2230',
        'shell-trim': '#2c3344',
        'shell-led-on': '#7fd9c3',
        'shell-led-off': '#3a4051',
        // 屏幕画布 —— 飞船舷窗主题
        'screen-bg': '#0a1929',
        'porthole-ring': '#1c3a5e',
        'porthole-glow': '#4fd1ff',
        // 生态缸
        'eco-deep': '#0d3b3e',
        'eco-mid': '#1a6c70',
        'eco-light': '#7fd9c3',
        // 货币
        'stardust': '#c5b3ff',
        'family-coin': '#ffd966',
        // 小可
        'xiaoke-primary': '#ffd966',
        'xiaoke-accent': '#ff8a65',
        // 新手光环
        'newbie-gold': '#ffd700',
        'newbie-purple': '#b076ff',
        'newbie-blue': '#5fb3ff',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
      },
      width: {
        'screen-canvas': '800px',
      },
      height: {
        'screen-canvas': '480px',
      },
      aspectRatio: {
        'screen-canvas': '5 / 3', // 真实硬件 800×480 横屏（来自 1.6 主界面规格）
      },
      animation: {
        'xiaoke-breathe': 'breathe 3s ease-in-out infinite',
        'led-pulse': 'led-pulse 2s ease-in-out infinite',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.04)' },
        },
        'led-pulse': {
          '0%, 100%': { opacity: '0.85' },
          '50%': { opacity: '1' },
        },
      },
      zIndex: {
        'layer-bg': '0',
        'layer-env': '10',
        'layer-char': '20',
        'layer-fx-weak': '30',
        'layer-ui-normal': '40',
        'layer-ui-focus': '45',
        'layer-feedback': '50',
        'layer-fx-strong': '60',
        'layer-mask': '70',
        'layer-modal': '80',
      },
    },
  },
  plugins: [],
};
