// Se conserva para pantallas antiguas, pero la marca principal de Limitarr es texto.
export function LogoMark({ className = 'w-8 h-8' }) {
  return (
    <span className={`${className} inline-flex items-center justify-center rounded-full bg-white flex-shrink-0`}>
      <svg viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2" className="w-[62%] h-[62%]">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 12 15.5 8.5" />
        <circle cx="12" cy="12" r="1.2" fill="black" stroke="none" />
      </svg>
    </span>
  );
}

export function Wordmark({ className = 'text-xl' }) {
  return (
    <span className={`${className} font-black tracking-[-0.045em] text-white`}>
      limit<span className="text-gray-400">ARR</span>
    </span>
  );
}
