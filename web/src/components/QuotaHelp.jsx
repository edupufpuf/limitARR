import { useState } from 'react';
import Sheet from './Sheet.jsx';

function HelpItem({ title, children }) {
  return (
    <div className="py-4 border-b border-bg-700 last:border-b-0">
      <h3 className="font-semibold text-gray-50">{title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-gray-500">{children}</p>
    </div>
  );
}

export function QuotaHelpSheet({ onClose }) {
  return (
    <Sheet
      title="¿Qué significa cada cupo?"
      subtitle="Son límites distintos y se comprueban a la vez."
      onClose={onClose}
      footer={<button type="button" onClick={onClose} className="btn btn-dark w-full">Entendido</button>}
    >
      <HelpItem title="Cupo por tipo de contenido">
        Cada biblioteca tiene su propio límite de contenido pendiente de ver. Películas, películas 4K y series se calculan por separado. Cuando ves o se retira algo, ese hueco vuelve a quedar libre.
      </HelpItem>
      <HelpItem title="Cupo mensual total">
        Es la suma de todo lo descargado y contabilizado durante el mes: películas, 4K y temporadas de series de todas las bibliotecas. Ver un contenido no devuelve este cupo; se reinicia al comenzar el mes siguiente.
      </HelpItem>
      <HelpItem title="Mensual por tipo, si aparece">
        Algunas bibliotecas pueden tener además un límite mensual propio. Solo suma el contenido ya contabilizado de ese tipo durante el mes. En series, cada temporada cuenta como una solicitud.
      </HelpItem>
      <p className="mt-2 rounded-xl bg-bg-800 px-4 py-3 text-sm leading-relaxed text-gray-400">
        Lo que aún no está disponible o sigue pendiente de aprobación aparece en la lista, pero no ocupa un hueco hasta que se descarga.
      </p>
    </Sheet>
  );
}

export default function QuotaHelp() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Explicar los tipos de cupo"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-bg-800 text-base font-bold text-gray-300 transition-colors hover:bg-bg-700"
        title="¿Qué significa cada cupo?"
      >
        ?
      </button>
      {open && <QuotaHelpSheet onClose={() => setOpen(false)} />}
    </>
  );
}
