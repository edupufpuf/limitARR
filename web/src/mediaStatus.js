// Motivo por el que un pendiente no cuenta para el cupo: media_status de Seerr
// (2 PENDING, 3 PROCESSING, resto/null = ni siquiera solicitada a Radarr/Sonarr).
export function downloadStatusLabel(item) {
  if (Number(item.mediaStatus) === 3) return 'Descargando';
  if (Number(item.mediaStatus) === 2) return 'Pendiente de descarga';
  return 'Sin descargar';
}

// Color distinto por etiqueta para distinguir de un vistazo el motivo.
export function downloadStatusColor(item) {
  if (Number(item.mediaStatus) === 3) return 'text-sky-300';
  if (Number(item.mediaStatus) === 2) return 'text-yellow-300';
  return 'text-gray-300';
}
