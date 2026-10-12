import { useEffect, useState } from 'react';

function HelpItem({ icon, title, children }) {
  return (
    <div className="rounded-2xl border border-bg-700 bg-bg-950/55 p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-accent-600/15 text-lg" aria-hidden="true">{icon}</span>
        <div>
          <h3 className="font-extrabold text-gray-100">{title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-gray-400">{children}</p>
        </div>
      </div>
    </div>
  );
}

export default function QuotaHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Explicar los tipos de cupo"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="quota-help-dialog"
        className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-bg-600 bg-bg-800 text-base font-black text-gray-300 transition-colors hover:border-accent-500 hover:text-white"
        title="¿Qué significa cada cupo?"
      >
        ?
      </button>

      {open ? (
        <div className="fixed inset-0 z-[70] flex items-end justify-center p-0 sm:items-center sm:p-5">
          <button type="button" aria-label="Cerrar ayuda" onClick={() => setOpen(false)} className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <section id="quota-help-dialog" role="dialog" aria-modal="true" aria-labelledby="quota-help-title" className="relative z-10 w-full max-w-lg rounded-t-[28px] border border-bg-600 bg-bg-900 p-5 shadow-2xl sm:rounded-[28px] sm:p-6">
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-bg-600 sm:hidden" />
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="quota-help-title" className="text-2xl font-extrabold tracking-tight text-white">¿Qué significa cada cupo?</h2>
                <p className="mt-1 text-sm text-gray-500">Son límites distintos y se comprueban a la vez.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Cerrar" className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-bg-800 text-xl text-gray-300">×</button>
            </div>

            <div className="mt-5 space-y-3">
              <HelpItem icon="📅" title="Cupo mensual total">
                Es la suma de todo lo descargado y contabilizado durante el mes: películas, 4K y temporadas de series de todas las bibliotecas. Ver un contenido no devuelve este cupo; se reinicia al comenzar el mes siguiente.
              </HelpItem>
              <HelpItem icon="🎬" title="Cupo por tipo de contenido">
                Cada biblioteca tiene su propio límite de contenido pendiente de ver. Películas, películas 4K y series se calculan por separado. Cuando ves o se retira algo, ese hueco vuelve a quedar libre.
              </HelpItem>
              <HelpItem icon="🗓️" title="Mensual por tipo, si aparece">
                Algunas bibliotecas pueden tener además un límite mensual propio. Solo suma el contenido ya contabilizado de ese tipo durante el mes. En series, cada temporada cuenta como una solicitud.
              </HelpItem>
            </div>

            <div className="mt-5 rounded-xl bg-sky-500/10 px-4 py-3 text-sm leading-relaxed text-sky-200">
              Lo que aún no está disponible o sigue pendiente de aprobación aparece en la lista, pero no ocupa un hueco hasta que se descarga.
            </div>
            <button type="button" onClick={() => setOpen(false)} className="btn btn-primary mt-5 w-full">Entendido</button>
          </section>
        </div>
      ) : null}
    </>
  );
}
