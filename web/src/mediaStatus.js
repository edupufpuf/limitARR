// item.queueStatus es el status tal cual de la cola de Radarr/Sonarr (Seerr lo
// reenvía sin traducir: "downloading", "queued", "paused", "delay", "completed"
// [importando], "downloadClientUnavailable", "failed", "warning", "fallback").
// null = nada en cola ahora mismo — en ese caso se cae a item.mediaStatus, el
// status 2/3 de Seerr, que solo dice "solicitada"/"monitorizada" (no que haya
// descarga activa: pasa con cualquier título aún sin estrenar, ver Toy Story 5).
// `bg` es sólido (no /20) a propósito — con fondo semitransparente costaba
// distinguir colores muy próximos (ámbar vs amarillo). `chipText` es el color
// de texto para ESE fondo sólido (amarillo/lime necesitan texto oscuro).
const QUEUE_STATUS = {
  downloading: { label: 'Descargando', color: 'text-sky-300', bg: 'bg-sky-600', chipText: 'text-white' },
  queued: { label: 'En cola', color: 'text-yellow-300', bg: 'bg-yellow-600', chipText: 'text-yellow-950' },
  paused: { label: 'Pausado', color: 'text-gray-300', bg: 'bg-gray-600', chipText: 'text-white' },
  delay: { label: 'Retrasado', color: 'text-orange-300', bg: 'bg-orange-600', chipText: 'text-white' },
  downloadClientUnavailable: { label: 'Cliente caído', color: 'text-rose-300', bg: 'bg-rose-600', chipText: 'text-white' },
  completed: { label: 'Importando', color: 'text-teal-300', bg: 'bg-teal-600', chipText: 'text-white' },
  failed: { label: 'Fallo de descarga', color: 'text-red-300', bg: 'bg-red-600', chipText: 'text-white' },
  warning: { label: 'Aviso', color: 'text-fuchsia-300', bg: 'bg-fuchsia-600', chipText: 'text-white' },
  fallback: { label: 'Buscando alternativa', color: 'text-lime-300', bg: 'bg-lime-600', chipText: 'text-lime-950' },
};
const PENDING = { label: 'Pendiente de descarga', color: 'text-yellow-300', bg: 'bg-yellow-600', chipText: 'text-yellow-950' };
const NONE = { label: 'Sin descargar', color: 'text-gray-300', bg: 'bg-gray-600', chipText: 'text-white' };
// item.radarrLabel (película) / item.sonarrLabel (serie): el estado real de
// Radarr/Sonarr cuando no hay nada en cola — más preciso que el "pendiente"
// genérico. Requieren radarr_url/sonarr_url en Configuración (opcionales); sin
// eso llegan null y se cae a PENDING como antes. Ver movieAvailability y
// getShowDetails en seerr.js.
const EXTERNAL = { color: 'text-cyan-300', bg: 'bg-cyan-600', chipText: 'text-white' };

function resolve(item) {
  if (item.queueStatus && QUEUE_STATUS[item.queueStatus]) return QUEUE_STATUS[item.queueStatus];
  if (item.radarrLabel || item.sonarrLabel) return { label: item.radarrLabel ?? item.sonarrLabel, ...EXTERNAL };
  if (Number(item.mediaStatus) === 2 || Number(item.mediaStatus) === 3) return PENDING;
  return NONE;
}

export function downloadStatusLabel(item) {
  return resolve(item).label;
}

// Color de texto para usos sobre fondo oscuro liso (p.ej. el detalle de
// pendiente, que no lleva chip de color propio).
export function downloadStatusColor(item) {
  return resolve(item).color;
}

// Fondo sólido para las etiquetas tipo "chip" sobre la carátula — distinto por
// estado para reconocerlas de un vistazo.
export function downloadStatusBg(item) {
  return resolve(item).bg;
}

// Color de texto a juego con downloadStatusBg (fondo sólido, no siempre vale
// el mismo texto claro: amarillo/lime necesitan texto oscuro para leerse).
export function downloadStatusChipText(item) {
  return resolve(item).chipText;
}
