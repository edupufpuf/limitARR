/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        // Seerr-style dark UI with purple accent.
        accent: {
          50: '#faf5ff',
          300: '#d8b4fe',
          400: '#c084fc',
          500: '#a855f7',
          600: '#8b5cf6',
          700: '#7c3aed',
        },
        // Navy con algo más de saturación que el gray de Tailwind, para que las
        // superficies tengan profundidad en vez de leerse como gris plano.
        bg: {
          950: '#0b1220',
          900: '#111a2a',
          800: '#172235',
          700: '#243149',
          600: '#34445f',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,.3), 0 8px 24px -12px rgba(0,0,0,.5)',
        glow: '0 0 0 1px rgba(168,85,247,.32), 0 14px 34px -14px rgba(139,92,246,.75)',
      },
    },
  },
  plugins: [],
};
