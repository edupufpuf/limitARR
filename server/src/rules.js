import * as radarr from './services/radarr.js';
import * as sonarr from './services/sonarr.js';
import { searchMedia, getItemWatchHistory } from './services/tautulli.js';

// Umbral de "visto" (mismo criterio que tv_season_watched_percent en el motor
// de cupo, pero constante local a propósito: Eliminarr no importa quota.js).
const WATCHED_PERCENT_THRESHOLD = 85;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalize(title) {
  return (title || '').toLowerCase().trim();
}

// Duplicado deliberado y pequeño del matching de quota.js (no exportado allí,
// y reutilizarlo acoplaría los dos módulos): busca en Tautulli el ratingKey de
// una película o serie por tmdbId o, si falla, por título normalizado.
export async function resolveRatingKey(title, tmdbId, mediaType) {
  if (!title) return null;
  const isTv = mediaType === 'show';
  const wanted = normalize(title);
  try {
    const { movies, shows } = await searchMedia(title);
    const tmdbGuid = tmdbId != null ? `tmdb://${tmdbId}` : null;
    const byTmdbOrTitle = (entry) => (tmdbGuid && entry.guids.includes(tmdbGuid)) || normalize(entry.title) === wanted;
    const hit = isTv ? shows.find(byTmdbOrTitle) : movies.find(byTmdbOrTitle);
    return hit?.ratingKey ?? null;
  } catch {
    return null; // sin Tautulli no se puede evaluar el historial, pero no se rompe el resto de condiciones
  }
}

async function lastWatchedAt(ratingKey, isTv) {
  if (!ratingKey) return null;
  const rows = await getItemWatchHistory(ratingKey, isTv);
  const watched = rows.filter((r) => r.percent >= WATCHED_PERCENT_THRESHOLD && r.watchedAt);
  if (watched.length === 0) return null;
  return Math.max(...watched.map((r) => r.watchedAt));
}

async function everWatched(ratingKey, isTv) {
  if (!ratingKey) return false;
  const rows = await getItemWatchHistory(ratingKey, isTv);
  return rows.some((r) => r.percent >= WATCHED_PERCENT_THRESHOLD);
}

const CONDITION_TYPES = {
  // Sin ver desde hace más de N días. Si nunca se vio (o no hay match en
  // Tautulli), cuenta como "desde siempre" y también cumple.
  async not_watched_days({ days }, item, ctx) {
    const watchedAt = await ctx.getLastWatchedAt();
    if (watchedAt == null) return true;
    return (Date.now() - watchedAt) / DAY_MS > days;
  },
  // Añadida hace más de N días Y cero reproducciones jamás. Distinta de la
  // anterior: una peli vista una vez hace años no cumple esta.
  async never_watched_added_days({ days }, item, ctx) {
    if (!item.added) return false;
    const addedAgoDays = (Date.now() - new Date(item.added).getTime()) / DAY_MS;
    if (addedAgoDays <= days) return false;
    return !(await ctx.getEverWatched());
  },
  // Tamaño en disco. No toca Tautulli.
  async file_size_over_gb({ gb }, item) {
    return item.sizeOnDisk / 1024 ** 3 > gb;
  },
};

const NEEDS_TAUTULLI = new Set(['not_watched_days', 'never_watched_added_days']);

function client(mediaType) {
  return mediaType === 'show' ? sonarr : radarr;
}

async function evaluateItem(rule, item) {
  const isTv = rule.media_type === 'show';
  const needsTautulli = rule.conditions.some((c) => NEEDS_TAUTULLI.has(c.type));

  let ratingKey = null;
  let cachedLastWatched;
  let cachedEverWatched;
  if (needsTautulli) ratingKey = await resolveRatingKey(item.title, item.tmdbId, rule.media_type);

  const ctx = {
    async getLastWatchedAt() {
      if (cachedLastWatched === undefined) cachedLastWatched = await lastWatchedAt(ratingKey, isTv);
      return cachedLastWatched;
    },
    async getEverWatched() {
      if (cachedEverWatched === undefined) cachedEverWatched = await everWatched(ratingKey, isTv);
      return cachedEverWatched;
    },
  };
  const results = [];
  for (const condition of rule.conditions) {
    const evaluator = CONDITION_TYPES[condition.type];
    if (!evaluator) continue;
    const matched = await evaluator(condition, item, ctx);
    results.push({ type: condition.type, params: condition, matched });
  }

  const overall = rule.condition_logic === 'any' ? results.some((r) => r.matched) : results.every((r) => r.matched);
  return { matched: overall, matchedConditions: results.filter((r) => r.matched) };
}

// Fuente de verdad única para "qué haría esta regla", usada tanto por la
// vista previa (dryRun:true) como por la ejecución real del scheduler
// (dryRun:false) — así preview y ejecución nunca pueden divergir.
export async function evaluateRule(rule, { dryRun = true } = {}) {
  const isTv = rule.media_type === 'show';
  const c = client(rule.media_type);
  const tagIds = rule.tag_ids && rule.tag_ids.length > 0 ? rule.tag_ids : undefined;
  const items = isTv ? await c.listSeries({ tagIds }) : await c.listMovies({ tagIds });

  const matches = [];
  for (const item of items) {
    const { matched, matchedConditions } = await evaluateItem(rule, item);
    if (!matched) continue;
    matches.push({
      externalId: item.id,
      tmdbId: item.tmdbId,
      title: item.title,
      posterUrl: item.posterUrl,
      sizeOnDisk: item.sizeOnDisk,
      matchedConditions,
    });
  }

  if (dryRun) return { matches };

  const options = rule.action_options || {};
  const executed = [];
  for (const match of matches) {
    try {
      if (rule.action === 'delete') {
        if (isTv) await c.deleteSeries(match.externalId, { deleteFiles: options.deleteFiles !== false });
        else await c.deleteMovie(match.externalId, { deleteFiles: options.deleteFiles !== false });
        executed.push({ ...match, actionTaken: 'deleted' });
      } else {
        await c.addTag(match.externalId, options.tagLabel || 'eliminarr-candidato');
        executed.push({ ...match, actionTaken: 'tagged' });
      }
    } catch (err) {
      executed.push({ ...match, actionTaken: 'error', error: err.message });
    }
  }
  return { matches: executed };
}
