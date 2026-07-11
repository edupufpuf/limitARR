import { useState } from 'react';
import { api } from '../api.js';
import { Wordmark } from '../components/Brand.jsx';

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
      </form>
    </div>
  );
}
