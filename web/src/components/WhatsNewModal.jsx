import { useEffect, useState } from 'react';
import { CHANGELOG } from '../changelog.js';

const SEEN_KEY = 'limitarr_whatsnew_seen';

export default function WhatsNewModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (CHANGELOG.length === 0) return;
    const seen = localStorage.getItem(SEEN_KEY);
    if (seen !== CHANGELOG[0].id) setOpen(true);
  }, []);

  function close() {
    localStorage.setItem(SEEN_KEY, CHANGELOG[0].id);
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={close}>
      <div className="card w-full max-w-md max-h-[80vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="font-extrabold text-xl">Novedades</h2>
          <button onClick={close} className="text-gray-500 hover:text-gray-200 text-xl leading-none">✕</button>
        </div>
        <div className="space-y-5 mt-4">
          {CHANGELOG.map((entry) => (
            <div key={entry.id}>
              <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">{entry.date}</div>
              <ul className="space-y-2">
                {entry.items.map((item, i) => (
                  <li key={i} className="text-sm text-gray-300 flex gap-2">
                    <span className="text-accent-400 flex-shrink-0">•</span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <button onClick={close} className="btn btn-primary w-full mt-6">Entendido</button>
      </div>
    </div>
  );
}
