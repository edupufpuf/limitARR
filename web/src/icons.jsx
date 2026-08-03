// Iconos de línea estilo Heroicons/Seerr — SVG a mano, sin dependencia nueva.
const base = {
  fill: 'none',
  viewBox: '0 0 24 24',
  strokeWidth: 1.8,
  stroke: 'currentColor',
};

export function IconGauge({ className }) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 12 15.5 8.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v.01M7 12h.01M17 12h.01" />
    </svg>
  );
}

export function IconSave({ className }) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 4v5h8V4" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 14h10v6H7z" />
    </svg>
  );
}

export function IconFilm({ className }) {
  return (
    <svg {...base} className={className}>
      <rect x="3" y="4" width="18" height="16" rx="2" strokeLinecap="round" strokeLinejoin="round" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 9h18M3 15h18M8 4v16M16 4v16" />
    </svg>
  );
}

export function IconSliders({ className }) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h9M17 6h3M4 18h3M11 18h9" />
      <circle cx="14" cy="6" r="2.2" />
      <circle cx="8" cy="18" r="2.2" />
    </svg>
  );
}

export function IconClock({ className }) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3.5 2" />
    </svg>
  );
}

export function IconBell({ className }) {
  return (
    <svg {...base} className={className}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M18 8a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6Z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 19a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function IconGear({ className }) {
  return (
    <svg {...base} className={className}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  );
}

export function IconLogout({ className }) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 17l5-5-5-5M21 12H9" />
    </svg>
  );
}

export function IconSearch({ className }) {
  return (
    <svg {...base} className={className}>
      <circle cx="11" cy="11" r="7" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function IconUsers({ className }) {
  return (
    <svg {...base} className={className}>
      <circle cx="9" cy="8" r="3.2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 5.5a3.2 3.2 0 0 1 0 5.4M18.5 14.7c1.3.7 2.2 1.9 2.5 3.8" />
    </svg>
  );
}

export function IconEye({ className }) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function IconBan({ className }) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M5.6 5.6l12.8 12.8" />
    </svg>
  );
}

export function IconCheckCircle({ className }) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" strokeLinejoin="round" d="m8.5 12.5 2.3 2.3 4.7-5" />
    </svg>
  );
}

export function IconXCircle({ className }) {
  return (
    <svg {...base} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M9 9l6 6M15 9l-6 6" />
    </svg>
  );
}

export function IconMenu({ className }) {
  return (
    <svg {...base} className={className}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
