/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        // Seerr-style dark UI, red accent instead of the usual indigo.
        accent: {
          50: '#fef2f2',
          300: '#fca5a5',
          400: '#f87171',
          500: '#ef4444',
          600: '#dc2626',
          700: '#b91c1c',
        },
        // Navy con algo más de saturación que el gray de Tailwind, para que las
        // superficies tengan profundidad en vez de leerse como gris plano.
        bg: {
          950: '#060912',
          900: '#0a0e1a',
          800: '#10172a',
          700: '#1c2438',
          600: '#2b364e',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,.3), 0 8px 24px -12px rgba(0,0,0,.5)',
        glow: '0 0 0 1px rgba(239,68,68,.25), 0 4px 20px -6px rgba(239,68,68,.45)',
      },
    },
  },
  plugins: [],
};
