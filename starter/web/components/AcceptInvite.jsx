import React, { useEffect, useState } from 'react';
import { request, describe } from '../api.js';
import Login from './Login.jsx';

// The public invite page. It shows only what GET /invites/:token returns — org name, role,
// email — and a refused token shows the server's reason and nothing about any org.
export default function AcceptInvite({ token }) {
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    request(`/invites/${encodeURIComponent(token)}`).then(setInvite).catch((err) => setError(describe(err)));
  }, [token]);

  async function accept(e) {
    e.preventDefault();
    setError(null);
    try {
      await request(`/invites/${encodeURIComponent(token)}/accept`, { method: 'POST', body: { name, password } });
      // The token leaves the address bar, then the person signs in normally.
      window.history.replaceState(null, '', '/');
      setDone(true);
    } catch (err) {
      setError(describe(err));
    }
  }

  if (done) {
    return <Login onLogin={async (email, pw) => {
      await request('/auth/login', { method: 'POST', body: { email, password: pw } });
      window.location.assign('/');
    }} notice="Invite accepted. Sign in to continue." />;
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={accept}>
        <h1>You're invited</h1>
        {!invite && !error && <p className="muted">Checking your invite…</p>}
        {error && <div className="error" data-testid="invite-error" role="alert">{error}</div>}
        {invite && (
          <>
            <p>
              Join <strong>{invite.orgName}</strong> as <strong data-testid="invite-role">{invite.role}</strong>.
            </p>
            <label>Email
              <input data-testid="invite-email" value={invite.email} readOnly />
            </label>
            <label>Your name
              <input data-testid="invite-name" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>Choose a password (8+ characters)
              <input data-testid="invite-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button data-testid="invite-submit" type="submit">Accept invite</button>
          </>
        )}
      </form>
    </div>
  );
}
