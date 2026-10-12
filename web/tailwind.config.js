import colors from 'tailwindcss/colors';
import plugin from 'tailwindcss/plugin';

// Tema minimalista (estilo Uber) en claro y oscuro: tinta, superficies y un
// rojo de acento. Las pantallas se escribieron para un tema oscuro, así que en
// vez de reescribir cada clase se remapean las escalas a variables CSS:
//   - `bg-*`: superficies (950 = página, 900 = barras y hojas, 800 = relleno
//     de tarjetas, 700/600 = separadores).
//   - `gray-*`: tinta, de gray-50 (la más fuerte) a gray-950 (la más suave).
//   - `ink` / `on-ink`: relleno de máximo contraste (negro en claro, blanco
//     en oscuro) y el texto que va encima.
//   - Tonos 100–400 de los colores de estado: se usan como texto, así que en
//     claro apuntan a tonos oscuros legibles sobre blanco.
// `html.dark` activa el juego oscuro (ver src/theme.js).

const STATUS_PALETTES = [
  'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan',
  'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
];
const TEXT_SHADES = [100, 200, 300, 400];
// En claro, el tono que sustituye a cada uno de TEXT_SHADES.
const LIGHT_TEXT_SHADE = { 100: 800, 200: 700, 300: 700, 400: 600 };

const THEMES = {
  light: {
    bg: { 950: '#ffffff', 900: '#ffffff', 800: '#f5f5f5', 700: '#ebebeb', 600: '#dedede' },
    gray: {
      50: '#000000', 100: '#0b0b0b', 200: '#1f1f1f', 300: '#333333', 400: '#545454', 500: '#6b6b6b',
      600: '#9a9a9a', 700: '#c7c7c7', 800: '#e3e3e3', 900: '#f2f2f2', 950: '#fafafa',
    },
    accent: { 50: '#fef2f2', 200: '#b91c1c', 300: '#c81e1e', 400: '#dc2626', 500: '#e5251b', 600: '#d81f15', 700: '#b3170f' },
    ink: '#000000',
    'on-ink': '#ffffff',
    status: (name, shade) => colors[name][LIGHT_TEXT_SHADE[shade]],
  },
  dark: {
    bg: { 950: '#000000', 900: '#141414', 800: '#1f1f1f', 700: '#2b2b2b', 600: '#3d3d3d' },
    gray: {
      50: '#ffffff', 100: '#f5f5f5', 200: '#e6e6e6', 300: '#d1d1d1', 400: '#a8a8a8', 500: '#8f8f8f',
      600: '#6b6b6b', 700: '#474747', 800: '#2b2b2b', 900: '#1a1a1a', 950: '#0d0d0d',
    },
    accent: { 50: '#2a0f0d', 200: '#fecaca', 300: '#fca5a5', 400: '#f87171', 500: '#ef4444', 600: '#e5251b', 700: '#c81e1e' },
    ink: '#ffffff',
    'on-ink': '#000000',
    status: (name, shade) => colors[name][shade],
  },
};

const channels = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};
const cssVar = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

function themeVars(theme) {
  const vars = {};
  for (const scale of ['bg', 'gray', 'accent']) {
    for (const [shade, hex] of Object.entries(theme[scale])) vars[`--c-${scale}-${shade}`] = channels(hex);
  }
  vars['--c-ink'] = channels(theme.ink);
  vars['--c-on-ink'] = channels(theme['on-ink']);
  for (const name of STATUS_PALETTES) {
    for (const shade of TEXT_SHADES) vars[`--c-${name}-${shade}`] = channels(theme.status(name, shade));
  }
  return vars;
}

const scaleOf = (scale) =>
  Object.fromEntries(Object.keys(THEMES.light[scale]).map((shade) => [shade, cssVar(`${scale}-${shade}`)]));

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        ...Object.fromEntries(
          STATUS_PALETTES.map((name) => [
            name,
            { ...colors[name], ...Object.fromEntries(TEXT_SHADES.map((shade) => [shade, cssVar(`${name}-${shade}`)])) },
          ])
        ),
        accent: scaleOf('accent'),
        bg: scaleOf('bg'),
        gray: scaleOf('gray'),
        ink: cssVar('ink'),
        'on-ink': cssVar('on-ink'),
      },
      boxShadow: {
        card: 'none',
        glow: 'none',
        sheet: '0 -8px 40px rgba(0,0,0,.12)',
      },
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ':root': { ...themeVars(THEMES.light), colorScheme: 'light' },
        'html.dark': { ...themeVars(THEMES.dark), colorScheme: 'dark' },
      });
    }),
  ],
};
