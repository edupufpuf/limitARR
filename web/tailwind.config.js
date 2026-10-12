import colors from 'tailwindcss/colors';

// Tema claro minimalista (estilo Uber): blanco, tinta casi negra y rojo de
// acento. Las pantallas se escribieron para un tema oscuro, así que en vez de
// reescribir cada clase se remapean las escalas: `bg-*` pasa a superficies
// claras, `gray-*` se invierte (gray-100 = tinta fuerte, gray-500 = texto
// secundario) y los tonos claros de los colores de estado (100–400), que se
// usaban como texto sobre fondo oscuro, apuntan a tonos oscuros legibles sobre
// blanco.

const darkenLightShades = (palette) => ({
  ...palette,
  100: palette[800],
  200: palette[700],
  300: palette[700],
  400: palette[600],
});

const STATUS_PALETTES = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan',
  'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
];

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        ...Object.fromEntries(STATUS_PALETTES.map((name) => [name, darkenLightShades(colors[name])])),
        accent: {
          50: '#fef2f2',
          200: '#b91c1c',
          300: '#c81e1e',
          400: '#dc2626',
          500: '#e5251b',
          600: '#d81f15',
          700: '#b3170f',
        },
        // Superficies: 950 = fondo de página, 900 = barras y hojas, 800 = relleno
        // de tarjetas, 700/600 = separadores y bordes.
        bg: {
          950: '#ffffff',
          900: '#ffffff',
          800: '#f5f5f5',
          700: '#ebebeb',
          600: '#dedede',
        },
        // Escala de tinta invertida.
        gray: {
          50: '#000000',
          100: '#0b0b0b',
          200: '#1f1f1f',
          300: '#333333',
          400: '#545454',
          500: '#6b6b6b',
          600: '#9a9a9a',
          700: '#c7c7c7',
          800: '#e3e3e3',
          900: '#f2f2f2',
          950: '#fafafa',
        },
      },
      boxShadow: {
        card: 'none',
        glow: 'none',
        sheet: '0 -8px 40px rgba(0,0,0,.12)',
      },
    },
  },
  plugins: [],
};
