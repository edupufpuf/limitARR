import { useEffect } from 'react';
import { IconX } from '../icons.jsx';

// Hoja inferior estilo Uber: sube desde abajo en móvil y se centra como
// diálogo en escritorio. Es el sitio donde vive el detalle que la pantalla
// principal oculta.
export default function Sheet({ title, subtitle, onClose, children, footer }) {
  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6">
      <button type="button" aria-label="Cerrar" onClick={onClose} className="absolute inset-0 bg-black/40 animate-fade-in" />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-lg max-h-[88vh] flex flex-col rounded-t-3xl sm:rounded-3xl bg-white shadow-sheet animate-sheet-up sm:animate-fade-in"
      >
        <div className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-bg-600 sm:hidden" />
        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <h2 className="text-2xl font-bold tracking-tight text-gray-50">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-bg-800 text-gray-100 hover:bg-bg-700"
          >
            <IconX className="h-5 w-5" />
          </button>
        </header>
        <div className="overflow-y-auto px-5 pb-5 sm:px-6 sm:pb-6">{children}</div>
        {footer && (
          <div className="border-t border-bg-700 px-5 py-4 sm:px-6" style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
            {footer}
          </div>
        )}
      </section>
    </div>
  );
}
