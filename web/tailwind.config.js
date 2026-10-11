/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        // Negro, blanco y rojo de estado: una base sobria y directa, inspirada
        // en la jerarquía visual de las apps de movilidad.
        accent: {
          50: '#fef2f2',
          300: '#fca5a5',
          400: '#f87171',
          500: '#ef4444',
          600: '#dc2626',
          700: '#b91c1c',
        },
        // Escala neutra sin el tinte azul anterior. Los saltos están pensados
        // para separar superficies con contraste, no con sombras decorativas.
        bg: {
          950: '#000000',
          900: '#0b0b0b',
          800: '#151515',
          700: '#292929',
          600: '#414141',
        },
      },
      boxShadow: {
        card: '0 1px 0 rgba(255,255,255,.04), 0 18px 50px -32px rgba(0,0,0,.95)',
        glow: '0 0 0 1px rgba(239,68,68,.24)',
      },
    },
  },
  plugins: [],
};
