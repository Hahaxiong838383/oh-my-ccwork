/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 飞船舷窗主题
        'porthole-bg': '#0a1929',
        'porthole-ring': '#1c3a5e',
        'porthole-glow': '#4fd1ff',
        'ecosystem-deep': '#0d3b3e',
        'ecosystem-mid': '#1a6c70',
        'ecosystem-light': '#7fd9c3',
        'k1-primary': '#ffd966',
        'k1-accent': '#ff8a65',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
      },
      animation: {
        'k1-breathe': 'breathe 3s ease-in-out infinite',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.04)' },
        },
      },
    },
  },
  plugins: [],
};
