// Marca de la app: esfera morada inspirada en el aire Seerr, con el gauge de limitARR.
export function LogoMark({ className = 'w-8 h-8' }) {
  return (
    <span className={`${className} relative inline-flex items-center justify-center rounded-full bg-gradient-to-br from-purple-300 via-accent-500 to-indigo-500 shadow-glow flex-shrink-0 overflow-hidden`}>
      <span className="absolute left-[18%] top-[12%] h-[12%] w-[44%] rounded-full bg-white/35 blur-[1px]" />
      <span className="absolute inset-[18%] rounded-full bg-bg-950/80 shadow-[inset_0_-10px_18px_rgba(0,0,0,.35)]" />
      <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" className="relative w-[52%] h-[52%]">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.8 14a6.7 6.7 0 1 0 12.4-4.8" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 12 16 8" />
        <circle cx="12" cy="12" r="1.35" fill="white" stroke="none" />
      </svg>
    </span>
  );
}

export function Wordmark({ className = 'text-xl' }) {
  return (
    <span className={`${className} font-extrabold tracking-tight text-white`}>
      limit<span className="text-accent-300">ARR</span>
    </span>
  );
}
