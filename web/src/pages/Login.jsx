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
    <div className="relative min-h-screen grid lg:grid-cols-2 bg-[#f3f3f3]">
      <div className="hidden lg:flex flex-col justify-between p-14 border-r border-bg-700 bg-bg-900">
        <Wordmark className="text-[38px]" />
        <div className="max-w-md">
          <p className="text-5xl font-black tracking-[-0.05em] leading-[1.02] text-white">Tu contenido.<br />Tu cupo.<br />Todo claro.</p>
          <p className="mt-6 text-gray-400 text-lg">Consulta solicitudes, descargas y límites desde un único lugar.</p>
        </div>
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-gray-600">limitARR</p>
      </div>
      <div className="flex items-center justify-center p-5 sm:p-10">
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="mb-10 lg:hidden">
          <Wordmark className="text-[38px]" dark />
        </div>
        <h1 className="text-3xl font-black tracking-tight text-black mb-2">Entrar</h1>
        <p className="text-gray-500 mb-8">Accede con tu cuenta de Plex o como administrador.</p>
        <input
          type="password"
          autoFocus
          placeholder="Contraseña admin"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input mb-4"
        />
        {error && <p className="text-accent-400 text-sm mb-4">{error}</p>}
        <button type="submit" disabled={loading} className="btn btn-primary w-full">
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
        <div className="flex items-center gap-3 my-6 text-xs font-bold uppercase tracking-[0.14em] text-gray-600">
          <span className="h-px flex-1 bg-bg-600" />o<span className="h-px flex-1 bg-bg-600" />
        </div>
        <button type="button" onClick={loginWithPlex} disabled={plexLoading} className="btn btn-ghost w-full">
          {plexLoading ? 'Esperando a Plex…' : 'Entrar con Plex'}
        </button>
      </form>
      </div>
    </div>
  );
}
