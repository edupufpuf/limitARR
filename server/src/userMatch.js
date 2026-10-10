// Empareja una identidad (email/username) contra una lista de candidatos con esos
// mismos campos. Usado para cruzar usuarios de Tautulli <-> Seerr en ambos sentidos.
export function matchByEmailOrUsername(candidates, { email, username }) {
  const e = email?.toLowerCase();
  const u = username?.toLowerCase();
  return (
    (e ? candidates.find((c) => c.email?.toLowerCase() === e) : null) ||
    (u ? candidates.find((c) => c.username?.toLowerCase() === u) : null) ||
    null
  );
}
