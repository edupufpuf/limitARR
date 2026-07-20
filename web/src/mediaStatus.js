// Motivo por el que un pendiente no cuenta para el cupo: media_status de Seerr
// (2 PENDING, 3 PROCESSING, resto/null = ni siquiera solicitada a Radarr/Sonarr).
// status 3 por sí solo NO significa descarga activa (Radarr la monitoriza desde
// que se aprueba, aunque aún no haya estrenado ni nada que bajar) — item.downloading
// viene de la cola real de Radarr/Sonarr y es lo que confirma que va en serio.
export function downloadStatusLabel(item) {
  if (Number(item.mediaStatus) === 3 && item.downloading) return 'Descargando';
  if (Number(item.mediaStatus) === 2 || Number(item.mediaStatus) === 3) return 'Pendiente de descarga';
  return 'Sin descargar';
}

// Color distinto por etiqueta para distinguir de un vistazo el motivo.
export function downloadStatusColor(item) {
  if (Number(item.mediaStatus) === 3 && item.downloading) return 'text-sky-300';
  if (Number(item.mediaStatus) === 2 || Number(item.mediaStatus) === 3) return 'text-yellow-300';
  return 'text-gray-300';
}

// Fondo a juego con downloadStatusColor, para las etiquetas tipo "chip" sobre
// la carátula — fondo de color en vez de negro liso para distinguirlas de un
// vistazo entre sí (no solo por el texto).
export function downloadStatusBg(item) {
  if (Number(item.mediaStatus) === 3 && item.downloading) return 'bg-sky-500/20 ring-1 ring-inset ring-sky-500/40';
  if (Number(item.mediaStatus) === 2 || Number(item.mediaStatus) === 3) return 'bg-yellow-500/20 ring-1 ring-inset ring-yellow-500/40';
  return 'bg-gray-500/20 ring-1 ring-inset ring-gray-500/40';
}
