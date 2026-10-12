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
    <div className="relative min-h-screen flex items-center justify-center p-4 overflow-hidden">
      <div className="absolute w-[480px] h-[480px] rounded-full bg-accent-600/15 blur-3xl pointer-events-none" />
      <form onSubmit={submit} className="relative card p-8 w-full max-w-sm">
        <div className="flex flex-col items-center gap-4 mb-8">
          <Wordmark className="text-[42px]" />
        </div>
        <input
          type="password"
          autoFocus
          placeholder="Contraseña admin"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input py-2 mb-4"
        />
        {error && <p className="text-accent-400 text-sm mb-4">{error}</p>}
        <button type="submit" disabled={loading} className="btn btn-primary w-full py-2">
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
        <div className="flex items-center gap-3 my-5 text-xs text-gray-600">
          <span className="h-px flex-1 bg-bg-600" />o<span className="h-px flex-1 bg-bg-600" />
        </div>
        <button type="button" onClick={loginWithPlex} disabled={plexLoading} className="btn btn-ghost w-full py-2">
          {plexLoading ? 'Esperando a Plex…' : 'Entrar con Plex'}
        </button>
      </form>
    </div>
  );
}
