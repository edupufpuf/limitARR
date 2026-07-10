import crypto from 'node:crypto';
import { getRawSetting, setRawSetting } from './settings.js';

const PASSWORD_HASH_KEY = 'admin_password_hash';
const SESSION_SECRET_KEY = 'session_secret';
const WEBHOOK_SECRET_KEY = 'webhook_secret';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
}

// true si nadie ha definido contraseña todavía: el panel debe mostrar la
// pantalla de "primer acceso" en vez del login normal.
export function needsSetup() {
  return !getRawSetting(PASSWORD_HASH_KEY);
}

export function setPassword(password) {
  setRawSetting(PASSWORD_HASH_KEY, hashPassword(password));
}

export function checkPassword(password) {
  const stored = getRawSetting(PASSWORD_HASH_KEY);
  if (!stored || !password) return false;
  return verifyPassword(password, stored);
}

// Si ya había un ADMIN_PASSWORD en env de un despliegue anterior, lo adopta como
// hash inicial la primera vez, para no romper el acceso al actualizar. En
// instalaciones nuevas sin la env var, se deja needsSetup()=true a propósito.
export function seedPasswordFromEnv() {
  if (needsSetup() && process.env.ADMIN_PASSWORD) {
    setPassword(process.env.ADMIN_PASSWORD);
  }
}

// Persistido en DB para sobrevivir reinicios sin depender de una env var; se
// genera solo una vez. SESSION_SECRET en env, si existe, siempre gana.
export function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

  let secret = getRawSetting(SESSION_SECRET_KEY);
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setRawSetting(SESSION_SECRET_KEY, secret);
  }
  return secret;
}

// Token en la propia URL del webhook público de Seerr, para que no cualquiera
// pueda pegar http://limitarr:5150/api/webhook/seerr/<lo-que-sea> y forzar
// ciclos de sondeo. No es una sesión, solo evita que sea totalmente adivinable.
export function getWebhookSecret() {
  let secret = getRawSetting(WEBHOOK_SECRET_KEY);
  if (!secret) {
    secret = crypto.randomBytes(16).toString('hex');
    setRawSetting(WEBHOOK_SECRET_KEY, secret);
  }
  return secret;
}
