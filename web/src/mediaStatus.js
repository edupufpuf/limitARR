// item.queueStatus es el status tal cual de la cola de Radarr/Sonarr (Seerr lo
// reenvía sin traducir: "downloading", "queued", "paused", "delay", "completed"
// [importando], "downloadClientUnavailable", "failed", "warning", "fallback").
// null = nada en cola ahora mismo — en ese caso se cae a item.mediaStatus, el
// status 2/3 de Seerr, que solo dice "solicitada"/"monitorizada" (no que haya
// descarga activa: pasa con cualquier título aún sin estrenar, ver Toy Story 5).
const QUEUE_STATUS = {
  downloading: { label: 'Descargando', color: 'text-sky-300', bg: 'bg-sky-500/20 ring-1 ring-inset ring-sky-500/40' },
  queued: { label: 'En cola', color: 'text-yellow-300', bg: 'bg-yellow-500/20 ring-1 ring-inset ring-yellow-500/40' },
  paused: { label: 'Pausado', color: 'text-gray-300', bg: 'bg-gray-500/20 ring-1 ring-inset ring-gray-500/40' },
  delay: { label: 'Retrasado', color: 'text-orange-300', bg: 'bg-orange-500/20 ring-1 ring-inset ring-orange-500/40' },
  downloadClientUnavailable: { label: 'Cliente caído', color: 'text-rose-300', bg: 'bg-rose-500/20 ring-1 ring-inset ring-rose-500/40' },
  completed: { label: 'Importando', color: 'text-teal-300', bg: 'bg-teal-500/20 ring-1 ring-inset ring-teal-500/40' },
  failed: { label: 'Fallo de descarga', color: 'text-red-300', bg: 'bg-red-500/20 ring-1 ring-inset ring-red-500/40' },
  warning: { label: 'Aviso', color: 'text-fuchsia-300', bg: 'bg-fuchsia-500/20 ring-1 ring-inset ring-fuchsia-500/40' },
  fallback: { label: 'Buscando alternativa', color: 'text-lime-300', bg: 'bg-lime-500/20 ring-1 ring-inset ring-lime-500/40' },
};
const PENDING = { label: 'Pendiente de descarga', color: 'text-yellow-300', bg: 'bg-yellow-500/20 ring-1 ring-inset ring-yellow-500/40' };
const NONE = { label: 'Sin descargar', color: 'text-gray-300', bg: 'bg-gray-500/20 ring-1 ring-inset ring-gray-500/40' };

function resolve(item) {
  if (item.queueStatus && QUEUE_STATUS[item.queueStatus]) return QUEUE_STATUS[item.queueStatus];
  if (Number(item.mediaStatus) === 2 || Number(item.mediaStatus) === 3) return PENDING;
  return NONE;
}

export function downloadStatusLabel(item) {
  return resolve(item).label;
}

// Color distinto por etiqueta para distinguir de un vistazo el motivo.
export function downloadStatusColor(item) {
  return resolve(item).color;
}

// Fondo a juego con downloadStatusColor, para las etiquetas tipo "chip" sobre
// la carátula — fondo de color en vez de negro liso para distinguirlas de un
// vistazo entre sí (no solo por el texto).
export function downloadStatusBg(item) {
  return resolve(item).bg;
}
