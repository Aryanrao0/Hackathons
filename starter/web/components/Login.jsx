import React, { useState } from 'react';
import { ApiError } from '../api.js';

// Sign-in. A refusal is shown with the server's own words and code, and stays on screen
// until the next attempt. The server answers a wrong password and an unknown account the
// same way; this screen repeats that answer and never improves on it.
export default function Login({ onLogin, notice, clearNotice }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    clearNotice?.();
    setBusy(true);
    try {
      await onLogin(email, password);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, { code: 'UNKNOWN', message: String(err?.message ?? err) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" data-testid="login-form" onSubmit={submit} noValidate>
        <h1>RemoteOps</h1>
        <p className="muted">Sign in to your organizations.</p>
        {notice && <div className="notice" role="status">{notice}</div>}
        <label>Email
          <input data-testid="login-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>Password
          <input data-testid="login-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <div className="error" data-testid="login-error" data-error-code={error.code} role="alert" aria-live="assertive">
            {error.message}
          </div>
        )}
        <button data-testid="login-submit" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
