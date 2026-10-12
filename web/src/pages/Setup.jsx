import { useState } from 'react';
import { api } from '../api.js';
import { Wordmark } from '../components/Brand.jsx';

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
    <div className="min-h-screen bg-bg-950 flex flex-col">
      <form onSubmit={submit} className="flex-1 w-full max-w-sm mx-auto px-6 flex flex-col justify-center">
        <Wordmark className="text-[44px]" />
        <p className="mt-2 mb-10 text-lg text-gray-500">
          Primer acceso — define la contraseña de admin.
        </p>
        <input
          type="password"
          autoFocus
          placeholder="Contraseña nueva (mín. 8)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="input mb-3"
        />
        <input
          type="password"
          placeholder="Repite la contraseña"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="input mb-4"
        />
        {error && <p className="text-accent-400 text-sm mb-4">{error}</p>}
        <button type="submit" disabled={loading} className="btn btn-dark w-full">
          {loading ? 'Guardando…' : 'Definir contraseña'}
        </button>
      </form>
    </div>
  );
}
