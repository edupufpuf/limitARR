import { useState } from 'react';
import { api } from '../api.js';

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
    <div className="min-h-screen flex items-center justify-center bg-bg-900">
      <form onSubmit={submit} className="bg-bg-800 rounded-lg p-8 w-full max-w-sm shadow-xl border border-bg-700">
        <h1 className="text-2xl font-bold text-accent-500 mb-2 text-center">limitARR</h1>
        <p className="text-sm text-gray-400 mb-6 text-center">
          Primer acceso — define la contraseña de admin.
        </p>
        <input
          type="password"
          autoFocus
          placeholder="Contraseña nueva (mín. 8)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded bg-bg-700 border border-bg-600 px-3 py-2 mb-3 text-gray-100 focus:outline-none focus:ring-2 focus:ring-accent-500"
        />
        <input
          type="password"
          placeholder="Repite la contraseña"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full rounded bg-bg-700 border border-bg-600 px-3 py-2 mb-4 text-gray-100 focus:outline-none focus:ring-2 focus:ring-accent-500"
        />
        {error && <p className="text-accent-400 text-sm mb-4">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-accent-600 hover:bg-accent-700 transition-colors rounded py-2 font-semibold disabled:opacity-50"
        >
          {loading ? 'Guardando…' : 'Definir contraseña'}
        </button>
      </form>
    </div>
  );
}
