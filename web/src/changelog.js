// Novedades para el popup "qué hay de nuevo" del panel de admin (Dashboard.jsx
// -> WhatsNewModal). Entradas más recientes primero; el id (fecha) se guarda
// en localStorage para no repetir el aviso una vez visto.
export const CHANGELOG = [
  {
    id: '2026-07-15',
    date: '15 jul 2026',
    items: [
      'Módulo Maintainerr: aviso en Telegram con botón 💾 Salvar cuando una película entra en la colección de borrado; al pulsarlo se mueve a la colección de salvados con días extra.',
      'Sección "Salvadas para ver" en el panel de usuario y en las tarjetas de Cupo del admin, con cuenta atrás y quién la salvó (via vínculo de "Mis avisos").',
      'Configuración del módulo en Avisos → "Salvar del borrado (Maintainerr)": URL, bot dedicado, chat/topic y colecciones de salvados.',
    ],
  },
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
