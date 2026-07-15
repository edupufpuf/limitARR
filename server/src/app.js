import express from 'express';
import cookieSession from 'cookie-session';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './db.js';
import { getSessionSecret } from './auth.js';
import { router as apiRouter } from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(__dirname, '../../web/dist');

// Separado de index.js para poder montar la app en tests (supertest) sin
// arrancar el listener ni los pollers de scheduler/Telegram.
export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // para que req.ip refleje al cliente real detrás de cloudflared/nginx
  app.use(cors({ origin: false }));
  app.use(express.json());
  app.use(
    cookieSession({
      name: 'limitarr_session',
      secret: getSessionSecret(),
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      // Por defecto en false porque el compose expone también HTTP directo en LAN
      // (puerto 5150) además del túnel HTTPS — activarlo a ciegas rompería el login
      // por ahí. Ponlo a "true" por env solo si TODO el acceso pasa por HTTPS.
      secure: process.env.COOKIE_SECURE === 'true',
    })
  );

  app.use('/api', apiRouter);
  app.use(express.static(webDist));
  app.get('*', (req, res) => res.sendFile(path.join(webDist, 'index.html')));

  // Sin esto, un error async sin capturar en una ruta (p.ej. Seerr devolviendo un
  // código inesperado) se convierte en unhandledRejection y Node mata el proceso
  // entero en vez de devolver un simple 500.
  app.use((err, req, res, next) => {
    console.error('[api] unhandled error:', err);
    res.status(500).json({ error: err.message });
  });

  return app;
}
