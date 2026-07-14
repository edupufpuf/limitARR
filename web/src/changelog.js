// Novedades para el popup "qué hay de nuevo" del panel de admin (Dashboard.jsx
// -> WhatsNewModal). Entradas más recientes primero; el id (fecha) se guarda
// en localStorage para no repetir el aviso una vez visto.
export const CHANGELOG = [
  {
    id: '2026-07-14',
    date: '14 jul 2026',
    items: [
      'Suplantar usuario: icono de ojo en cada tarjeta de Cupo para ver el panel "Mi cupo" tal cual lo ve ese usuario, con vuelta a admin sin perder tu sesión.',
      'El aviso "Usuario sin cupo" ya se puede desactivar, igual que los demás avisos de Telegram.',
      'Vincular Telegram con un click desde "Mis avisos": ya no hace falta escribir al bot y esperar a que un admin lo vincule a mano.',
    ],
  },
];
