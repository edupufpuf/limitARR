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
