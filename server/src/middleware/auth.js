export function requireAuth(req, res, next) {
  if (req.session?.authed) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}

export function requireAdmin(req, res, next) {
  // Las sesiones creadas antes de existir los roles no tienen `role`. Eran
  // necesariamente sesiones admin por contraseña, así que se mantienen válidas.
  if (req.session?.authed && req.session?.role !== 'user') return next();
  return res.status(403).json({ error: 'admin_required' });
}
