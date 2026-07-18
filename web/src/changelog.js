// Novedades para el popup "qué hay de nuevo" del panel de admin (Dashboard.jsx
// -> WhatsNewModal). Entradas más recientes primero; el id (fecha) se guarda
// en localStorage para no repetir el aviso una vez visto.
export const CHANGELOG = [
  {
    id: '2026-07-18',
    date: '18 jul 2026',
    items: [
      'Cupo mensual: tope de cosas aprobadas al mes por biblioteca, aunque se vean. Desactivado por defecto; se activa y configura en la pestaña Cupo.',
      'Roles en Usuarios: ponen límite, caducidad y cupo mensual de golpe a todos sus miembros (con los roles Usuario, Amigo, Invitado y Admin ya creados). Precedencia: override individual > override de grupo > rol > límite de biblioteca.',
      'Temporizador de aprobación: en Pendientes de aprobación, botón "Aplazar" para que una solicitud concreta no se apruebe hasta pasados N días, aunque haya cupo de sobra.',
      'Nueva pestaña Usuarios (antes Overrides): grupos, roles y una ficha por usuario con su grupo/rol y overrides propios, todo junto y buscable.',
    ],
  },
];
