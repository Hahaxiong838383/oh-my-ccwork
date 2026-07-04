import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 暖白编辑风（参考 Apple 中文官网）—— 2026-05-31 整站从深色翻暖白
        bg: {
          primary: '#FBFBFA',
          secondary: '#FFFFFF',
          card: '#FFFFFF',
        },
        text: {
          primary: '#1D1D1F',
          secondary: '#52525B',
          muted: '#86868B',
        },
        accent: {
          DEFAULT: '#0071E3',
          subtle: 'rgba(0, 113, 227, 0.06)',
          glow: 'rgba(0, 113, 227, 0.12)',
        },
        border: {
          DEFAULT: 'rgba(0, 0, 0, 0.08)',
          hover: 'rgba(0, 0, 0, 0.14)',
        },
        // 暖点缀色（来自 B2 hero）
        amber: '#B7791F',
        violet: '#6D5BD0',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Display"',
          '"SF Pro Text"',
          '"PingFang SC"',
          '"Helvetica Neue"',
          '"Microsoft YaHei"',
          'sans-serif',
        ],
        mono: ['"SF Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      maxWidth: {
        content: '1200px',
      },
      animation: {
        'appear': 'appear 0.6s var(--ease-out) forwards',
        'appear-zoom': 'appear-zoom 0.6s var(--ease-out) forwards',
        'ticker': 'ticker 0.6s var(--ease-out) forwards',
      },
      keyframes: {
        appear: {
          from: { opacity: '0', transform: 'translateY(12px)', filter: 'blur(4px)' },
          to: { opacity: '1', transform: 'translateY(0)', filter: 'blur(0)' },
        },
        'appear-zoom': {
          from: { opacity: '0', transform: 'scale(0.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        ticker: {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}

export default config
