import { useState } from 'react';
import { api } from '../api.js';

export default function Login({ onLoggedIn }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

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

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-900">
      <form onSubmit={submit} className="bg-bg-800 rounded-lg p-8 w-full max-w-sm shadow-xl border border-bg-700">
        <h1 className="text-2xl font-bold text-accent-500 mb-6 text-center">limitARR</h1>
        <input
          type="password"
          autoFocus
          placeholder="Contraseña admin"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded bg-bg-700 border border-bg-600 px-3 py-2 mb-4 text-gray-100 focus:outline-none focus:ring-2 focus:ring-accent-500"
        />
        {error && <p className="text-accent-400 text-sm mb-4">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-accent-600 hover:bg-accent-700 transition-colors rounded py-2 font-semibold disabled:opacity-50"
        >
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
