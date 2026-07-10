import express from 'express';
import cookieSession from 'cookie-session';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import './db.js';
import { seedSettingsFromEnv } from './settings.js';
import { seedPasswordFromEnv, getSessionSecret } from './auth.js';
import { router as apiRouter } from './routes/api.js';
import { startScheduler } from './scheduler.js';
import { startTelegramPoller } from './services/telegram.js';

seedSettingsFromEnv();
seedPasswordFromEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.join(__dirname, '../../web/dist');

const app = express();
app.use(cors({ origin: false }));
app.use(express.json());
app.use(
  cookieSession({
    name: 'limitarr_session',
    secret: getSessionSecret(),
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
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

app.listen(config.port, () => {
  console.log(`limitARR listening on :${config.port}`);
  startScheduler();
  startTelegramPoller();
});
