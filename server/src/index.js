import { config } from './config.js';
import './db.js';
import { seedSettingsFromEnv } from './settings.js';
import { seedPasswordFromEnv } from './auth.js';
import { createApp } from './app.js';
import { startScheduler } from './scheduler.js';
import { startTelegramPoller } from './services/telegram.js';
import { startEliminarrScheduler } from './eliminarrScheduler.js';

seedSettingsFromEnv();
seedPasswordFromEnv();

createApp().listen(config.port, () => {
  console.log(`limitARR listening on :${config.port}`);
  startScheduler();
  startTelegramPoller();
  startEliminarrScheduler();
});
