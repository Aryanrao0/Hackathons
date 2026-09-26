import React, { useCallback, useEffect, useRef, useState } from 'react';
import { request, refreshSession, ApiError, describe } from './api.js';
import { allows, gate, themeColours } from './presence.js';
import Login from './components/Login.jsx';
import Devices from './components/Devices.jsx';
import People from './components/People.jsx';
import Grants from './components/Grants.jsx';
import Sessions from './components/Sessions.jsx';
import Audit from './components/Audit.jsx';
import Admin from './components/Admin.jsx';

// The cards, and the permission that governs each (UI-INVENTORY.md §2). This says which
// permission a card is ABOUT; whether the caller holds it always comes from the server.
const CARDS = [
  { key: 'devices', label: 'Devices', any: ['device:list'], View: Devices },
  { key: 'people', label: 'People', any: ['user:read'], View: People },
  { key: 'grants', label: 'Grants', any: ['user:read'], View: Grants },
  { key: 'sessions', label: 'Sessions', any: ['session:view'], View: Sessions },
  { key: 'audit', label: 'Audit', any: ['audit:read'], View: Audit },
  { key: 'admin', label: 'Admin', any: ['org:update', 'org:delete'], View: Admin },
];

const heldBy = (perms, card) => card.any.find((p) => allows(perms, p));

export default function App() {
  // session: { token, orgId, role, orgs, user }   me: the /auth/me body for that token
  const [session, setSession] = useState(null);
  const [me, setMe] = useState(null);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState('devices');
  const [banner, setBanner] = useState(null);
  const [notice, setNotice] = useState(null);
  const tokenRef = useRef(null);

  const adopt = useCallback(async (body) => {
    tokenRef.current = body.token;
    setSession(body);
    if (!body.token) { setMe(null); return; }
    try {
      setMe(await request('/auth/me', { token: body.token }));
    } catch (err) {
      // A suspended membership still has a session; it just has no authority here.
      if (err instanceof ApiError && err.reason === 'suspended') setMe({ suspended: true, orgId: body.orgId });
      else throw err;
    }
  }, []);

  // Every authenticated call goes through here. A stale token (the server's permission
  // version moved on) is refreshed for the same org and the call retried once.
  const call = useCallback(async (path, opts = {}) => {
    try {
      return await request(path, { ...opts, token: tokenRef.current });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
      if (err.code !== 'TOKEN_STALE') { signOutLocally(); throw err; }
      const body = await refreshSession(session?.orgId);
      await adopt(body);
      return request(path, { ...opts, token: tokenRef.current });
    }
  }, [adopt, session?.orgId]);

  function signOutLocally() {
    tokenRef.current = null;
    setSession(null);
    setMe(null);
  }

  // Boot: the access token was only ever in memory, so a reload restores it from the
  // httpOnly refresh cookie. No cookie -> the login screen.
  useEffect(() => {
    let cancelled = false;
    refreshSession()
      .then((body) => !cancelled && adopt(body))
      .catch(() => {})
      .finally(() => !cancelled && setBooting(false));
    return () => { cancelled = true; };
  }, [adopt]);

  async function login(email, password) {
    const body = await request('/auth/login', { method: 'POST', body: { email, password } });
    setView('devices');
    await adopt(body);
  }

  async function switchOrg(orgId) {
    setBanner(null);
    try {
      const body = await call('/auth/token', { method: 'POST', body: { orgId } });
      setMe(null);      // nothing from the old org survives the switch
      setView('devices');
      await adopt(body);
    } catch (err) {
      setBanner(describe(err));
    }
  }

  async function createOrg() {
    const name = window.prompt('Name for the new organization');
    if (name === null) return;
    try {
      const org = await call('/orgs', { method: 'POST', body: { name } });
      await switchOrg(org.id);
    } catch (err) {
      setBanner(describe(err));
    }
  }

  async function signOut() {
    try { await request('/auth/logout', { method: 'POST' }); } catch { /* signing out anyway */ }
    signOutLocally();
  }

  if (booting) return <div className="boot">Loading…</div>;
  if (!session?.token && !session?.orgs?.length) {
    return <Login onLogin={login} notice={notice} clearNotice={() => setNotice(null)} />;
  }

  const orgs = session.orgs ?? [];
  const active = orgs.find((o) => o.id === session.orgId);
  const perms = me?.permissions ?? {};
  const visibleCards = CARDS.filter((c) => heldBy(perms, c));
  const current = visibleCards.find((c) => c.key === view) ?? visibleCards[0] ?? null;
  const colours = themeColours(active?.theme ?? 'none');

  return (
    <div
      data-testid="app-shell"
      data-org-id={session.orgId ?? ''}
      data-org-theme={active?.theme ?? ''}
      className="shell"
      style={{ '--accent': colours.accent, '--accent-ink': colours.ink, backgroundColor: colours.tint }}
    >
      <aside className="sidebar">
        <div className="brand">RemoteOps</div>
        <div className="section-label">Organizations</div>
        {orgs.map((o) => {
          const c = themeColours(o.theme);
          return (
            <button
              key={o.id}
              data-testid="org-option"
              data-org-id={o.id}
              className={`org-option${o.id === session.orgId ? ' active' : ''}`}
              aria-current={o.id === session.orgId ? 'true' : undefined}
              onClick={() => o.id !== session.orgId && switchOrg(o.id)}
            >
              <span className="swatch" style={{ background: c.accent }} />
              <span className="org-name">{o.name}</span>
              <span className="org-role">{o.role}{o.status === 'suspended' ? ' · suspended' : ''}</span>
            </button>
          );
        })}
        <button data-testid="create-org" className="ghost" onClick={createOrg}>+ New organization</button>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="org-title">{active?.name ?? 'No organization'}</div>
            <div className="who">
              {session.user?.email} · role <strong data-testid="active-role">{session.role ?? '—'}</strong>
            </div>
          </div>
          <button className="ghost" data-testid="sign-out" onClick={signOut}>Sign out</button>
        </header>

        {banner && <div className="banner" role="alert">{banner}<button className="link" onClick={() => setBanner(null)}>dismiss</button></div>}

        {me?.suspended && (
          <div className="banner" role="alert">Your membership in this organization is suspended. Switch to another organization or ask an admin to reinstate you.</div>
        )}
        {!session.token && <div className="empty">You are not an active member of any organization. Create one to get started.</div>}

        {session.token && me && !me.suspended && (
          <>
            <nav className="tabs">
              {visibleCards.map((c) => (
                <button
                  key={c.key}
                  data-testid={`nav-${c.key}`}
                  {...gate(heldBy(perms, c))}
                  className={current?.key === c.key ? 'tab active' : 'tab'}
                  onClick={() => setView(c.key)}
                >
                  {c.label}
                </button>
              ))}
            </nav>
            <section className="panel">
              {current
                ? <current.View key={`${session.orgId}:${current.key}`} call={call} me={me} orgId={session.orgId} onOrgChanged={() => switchOrg(session.orgId)} onOrgDeleted={async () => {
                    const next = await refreshSession();
                    setView('devices');
                    await adopt(next);
                  }} />
                : <div className="empty">You have no permissions in this organization.</div>}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
