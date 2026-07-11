// Marca de la app: cuadradito rojo con el gauge (mismo dibujo que el favicon)
// y wordmark "limitARR" con el ARR en rojo.
export function LogoMark({ className = 'w-8 h-8' }) {
  return (
    <span className={`${className} inline-flex items-center justify-center rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 shadow-glow flex-shrink-0`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" className="w-[62%] h-[62%]">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 12 15.5 8.5" />
        <circle cx="12" cy="12" r="1.2" fill="white" stroke="none" />
      </svg>
    </span>
  );
}

export function Wordmark({ className = 'text-xl' }) {
  return (
    <span className={`${className} font-bold tracking-tight`}>
      limit<span className="text-accent-500">ARR</span>
    </span>
  );
}
