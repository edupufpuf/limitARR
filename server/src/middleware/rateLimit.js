// Rate limit simple en memoria, sin dependencias nuevas. Basta para frenar
// fuerza bruta contra la contraseña de admin en un homelab de un solo proceso
// — no sirve si algún día hay varias réplicas detrás de un balanceador.
//
// Nota: si limitARR queda detrás de un proxy (Cloudflare Tunnel, nginx, ...)
// sin "trust proxy" configurado en Express, req.ip puede ser siempre la misma
// IP interna, y entonces el límite aplica de forma global en vez de por
// atacante real. Sigue siendo mejor que nada.
export function rateLimit({ max = 5, windowMs = 15 * 60 * 1000 } = {}) {
  // Cada política mantiene su propio contador. Así el sondeo del PIN de Plex
  // no consume los cinco intentos reservados al login con contraseña.
  const attempts = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = attempts.get(key);

    if (!entry || now > entry.resetAt) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= max) {
      const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds });
    }

    entry.count += 1;
    next();
  };
}
