import { useThemePref } from '../theme.js';

const OPTIONS = [
  { value: 'system', label: 'Sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Oscuro' },
];

// Control segmentado Sistema / Claro / Oscuro.
export default function ThemeSwitch({ className = '' }) {
  const [pref, setPref] = useThemePref();
  return (
    <div role="radiogroup" aria-label="Tema" className={`grid grid-cols-3 gap-1 p-1 rounded-xl bg-bg-800 ${className}`}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={pref === o.value}
          onClick={() => setPref(o.value)}
          className={`rounded-lg py-1.5 text-xs transition-colors ${
            pref === o.value ? 'bg-bg-950 dark:bg-bg-600 text-gray-50 font-semibold shadow-sm' : 'text-gray-500 hover:text-gray-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
