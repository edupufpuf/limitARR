import { useState } from 'react';
import { api } from '../api.js';
import { Wordmark } from '../components/Brand.jsx';

export default function Login({ onLoggedIn }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [plexLoading, setPlexLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.login(password);
      onLoggedIn();
    } catch {
      setError('Contraseña incorrecta');
    } finally {
      setLoading(false);
    }
  }

  async function loginWithPlex() {
    setPlexLoading(true);
    setError(null);
    let popup;
    try {
      const { authUrl } = await api.plexStart();
      popup = window.open(authUrl, 'limitarr-plex-auth', 'popup,width=720,height=760');
      if (!popup) throw new Error('popup_blocked');
      for (let attempt = 0; attempt < 75; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1600));
        if (popup.closed) throw new Error('cancelled');
        const result = await api.plexCheck();
        if (!result.pending) {
          popup.close();
          onLoggedIn();
          return;
        }
      }
      throw new Error('timeout');
    } catch (err) {
      popup?.close();
      setError(
        err.message === 'popup_blocked'
          ? 'Permite ventanas emergentes para entrar con Plex'
          : err.message === 'cancelled'
            ? 'Acceso con Plex cancelado'
            : 'No se pudo validar la cuenta Plex'
      );
    } finally {
      setPlexLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <main className="flex-1 w-full max-w-sm mx-auto px-6 flex flex-col justify-center">
        <Wordmark className="text-[44px]" />
        <p className="mt-2 mb-10 text-lg text-gray-500">Tu cupo de Plex, de un vistazo.</p>

        <button type="button" onClick={loginWithPlex} disabled={plexLoading} className="btn btn-dark w-full">
          {plexLoading ? 'Esperando a Plex…' : 'Entrar con Plex'}
        </button>

        <div className="flex items-center gap-3 my-6 text-sm text-gray-500">
          <span className="h-px flex-1 bg-bg-700" />o<span className="h-px flex-1 bg-bg-700" />
        </div>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="password"
            aria-label="Contraseña de administrador"
            placeholder="Contraseña de administrador"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
          <button type="submit" disabled={loading || !password} className="btn btn-ghost w-full">
            {loading ? 'Entrando…' : 'Entrar como admin'}
          </button>
        </form>
        {error && <p role="alert" className="mt-4 text-sm text-accent-400">{error}</p>}
      </main>
    </div>
  );
}
