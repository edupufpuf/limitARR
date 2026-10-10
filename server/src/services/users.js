import { getUsers as getTautulliUsers } from './tautulli.js';
import { getSeerrUsers } from './seerr.js';
import { matchByEmailOrUsername } from '../userMatch.js';

// Los ids de Tautulli/Plex son positivos y actualmente muy inferiores a este
// rango. Los usuarios exclusivamente locales de Seerr necesitan una identidad
// estable para overrides, roles, grupos y decisions_log sin confundirse con
// los grupos agregados (que usan ids negativos).
export const SEERR_LOCAL_USER_BASE = 5_000_000_000;

export function seerrLocalUserId(seerrUserId) {
  return SEERR_LOCAL_USER_BASE + Number(seerrUserId);
}

export function isSeerrLocalUserId(userId) {
  return Number(userId) >= SEERR_LOCAL_USER_BASE;
}

export function seerrIdFromLocalUserId(userId) {
  return isSeerrLocalUserId(userId) ? Number(userId) - SEERR_LOCAL_USER_BASE : null;
}

export function mergeLimitarrUsers(tautulliUsers, seerrUsers) {
  const matchedSeerrIds = new Set();
  const plexUsers = tautulliUsers.map((user) => {
    const seerrUser = matchByEmailOrUsername(seerrUsers, user);
    if (seerrUser) matchedSeerrIds.add(seerrUser.id);
    return { ...user, source: 'plex', seerrId: seerrUser?.id ?? null };
  });
  const localUsers = seerrUsers
    .filter((user) => !matchedSeerrIds.has(user.id))
    .map((user) => ({
      id: seerrLocalUserId(user.id),
      seerrId: user.id,
      username: user.username || user.email || `seerr#${user.id}`,
      email: user.email ?? null,
      friendlyName: user.username || user.email || `Seerr #${user.id}`,
      avatar: user.avatar ?? null,
      isAdmin: false,
      source: 'seerr',
    }));

  return [...plexUsers, ...localUsers].sort((a, b) =>
    String(a.username || '').localeCompare(String(b.username || ''), 'es')
  );
}

// Usuarios administrables por limitARR: todos los de Plex/Tautulli y, además,
// las cuentas locales de Seerr que no se pueden emparejar por email/usuario.
// Si Seerr está temporalmente caído se conserva la lista de Plex.
export async function getLimitarrUsers() {
  const tautulliUsers = await getTautulliUsers();
  let seerrUsers = [];
  try {
    seerrUsers = await getSeerrUsers();
  } catch {
    return tautulliUsers.map((user) => ({ ...user, source: 'plex', seerrId: null }));
  }

  return mergeLimitarrUsers(tautulliUsers, seerrUsers);
}
