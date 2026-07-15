import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 5150),
  // Seerr/Tautulli connection settings live in the DB (see settings.js), editable
  // from the panel. Env vars SEERR_URL/SEERR_API_KEY/TAUTULLI_URL/TAUTULLI_API_KEY
  // are only used to seed the DB on first boot.
  //
  // Contraseña de admin: ver auth.js. ADMIN_PASSWORD (opcional) solo siembra la
  // contraseña la primera vez; después se gestiona como hash en la DB, cambiable
  // desde el panel (pestaña Configuración).
  dbPath: process.env.DB_PATH || './data/limitarr.db',
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 60_000),
  // Si una solicitud aprobada lleva más de esto sin llegar a "disponible" en Seerr
  // (nunca llega a descargarse), se libera su hueco de cupo automáticamente.
  stuckRequestGraceDays: Number(process.env.STUCK_REQUEST_GRACE_DAYS || 7),
  // Mantenimiento diario (scheduler): retención del registro de decisiones
  // (solo filas que ya no afectan al cupo) y nº de backups diarios a conservar.
  decisionsRetentionDays: Number(process.env.DECISIONS_RETENTION_DAYS || 365),
  backupKeep: Number(process.env.BACKUP_KEEP || 7),
};
