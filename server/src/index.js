import { config } from './config.js';
import './db.js';
import { seedSettingsFromEnv } from './settings.js';
import { seedPasswordFromEnv } from './auth.js';
import { createApp } from './app.js';
import { startScheduler } from './scheduler.js';
import { startTelegramPoller } from './services/telegram.js';
import { startMaintainerrPoller } from './services/maintainerr.js';
import { startStreamLimitPoller } from './services/streamGuard.js';

seedSettingsFromEnv();
seedPasswordFromEnv();

createApp().listen(config.port, () => {
  console.log(`limitARR listening on :${config.port}`);
  startScheduler();
  startTelegramPoller();
  startMaintainerrPoller();
  startStreamLimitPoller();
});
