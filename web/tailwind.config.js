/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Seerr-style dark UI, red accent instead of the usual indigo.
        accent: {
          50: '#fef2f2',
          400: '#f87171',
          500: '#ef4444',
          600: '#dc2626',
          700: '#b91c1c',
        },
        bg: {
          900: '#0b0f19',
          800: '#111827',
          700: '#1f2937',
          600: '#374151',
        },
      },
    },
  },
  plugins: [],
};
