import { useState } from 'react';
import { api } from '../api.js';
import { LogoMark, Wordmark } from '../components/Brand.jsx';

export default function Setup({ onDone }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError('Mínimo 8 caracteres');
      return;
    }
    if (password !== confirm) {
      setError('No coinciden');
      return;
    }

    setLoading(true);
    try {
      await api.setup(password);
      onDone();
    } catch {
      setError('No se pudo guardar la contraseña');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center p-4 overflow-hidden">
      <div className="absolute w-[480px] h-[480px] rounded-full bg-accent-600/15 blur-3xl pointer-events-none" />
      <form onSubmit={submit} className="relative card p-8 w-full max-w-sm">
        <div className="flex flex-col items-center gap-4 mb-2">
          <LogoMark className="w-20 h-20" />
          <Wordmark className="text-5xl" />
        </div>
        <p className="text-sm text-gray-400 mb-6 text-center">
          Primer acceso — define la contraseña de admin.
        </p>
        <input
          type="password"
          autoFocus
          placeholder="Contraseña nueva (mín. 8)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input py-2 mb-3"
        />
        <input
          type="password"
          placeholder="Repite la contraseña"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="input py-2 mb-4"
        />
        {error && <p className="text-accent-400 text-sm mb-4">{error}</p>}
        <button type="submit" disabled={loading} className="btn btn-primary w-full py-2">
          {loading ? 'Guardando…' : 'Definir contraseña'}
        </button>
      </form>
    </div>
  );
}
