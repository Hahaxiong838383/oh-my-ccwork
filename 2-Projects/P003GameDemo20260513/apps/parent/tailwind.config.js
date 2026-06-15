/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'page-bg': '#F5F5F7',
        'brand-orange': '#FF7A33',
        'text-main': '#1A1A1A',
        'text-muted': '#8A8A8A',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 12px 30px rgba(26, 26, 26, 0.08)',
        phone: '0 30px 80px rgba(0, 0, 0, 0.35)',
      },
    },
  },
  plugins: [],
};
