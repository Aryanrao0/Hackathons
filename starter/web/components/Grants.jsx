import React, { useState } from 'react';
import { allows, gate } from '../presence.js';
import { useResource, useAction, Feedback } from './common.jsx';

// Grants in the active org. The permission checkboxes are the catalogue the SERVER sent
// (the keys of /auth/me permissions), so an undocumented permission is offered too.
export default function Grants({ call, me, orgId }) {
  const grants = useResource(call, `/orgs/${orgId}/grants`);
  const members = useResource(call, `/orgs/${orgId}/members`);
  const [devices, setDevices] = useState([]);
  const { message, run } = useAction();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ userId: '', deviceId: '', effect: 'allow', permissions: [], expiresAt: '' });
  const can = (p) => allows(me.permissions, p);
  const catalogue = Object.keys(me.permissions).sort();
  const nameOf = (id) => members.data?.members.find((m) => m.user_id === id)?.email ?? id;

  function openForm() {
    setOpen((v) => !v);
    // Device choices need device:list; without it a grant can still be org-wide.
    if (can('device:list')) call(`/orgs/${orgId}/devices`).then((r) => setDevices(r.devices)).catch(() => setDevices([]));
  }

  function toggle(key) {
    setDraft((d) => ({ ...d, permissions: d.permissions.includes(key) ? d.permissions.filter((k) => k !== key) : [...d.permissions, key] }));
  }

  function submit(e) {
    e.preventDefault();
    const body = { userId: draft.userId, effect: draft.effect, permissions: draft.permissions };
    if (draft.deviceId) body.deviceId = draft.deviceId;
    if (draft.expiresAt) body.expiresAt = new Date(draft.expiresAt).toISOString();
    run(() => call(`/orgs/${orgId}/grants`, { method: 'POST', body }).then(() => {
      setOpen(false);
      setDraft({ userId: '', deviceId: '', effect: 'allow', permissions: [], expiresAt: '' });
      return grants.reload();
    }), 'Grant created. It applies from the grantee\'s next request.');
  }

  return (
    <div>
      <div className="panel-head">
        <h2>Grants</h2>
        {can('grant:create') && <button data-testid="new-grant" {...gate('grant:create')} onClick={openForm}>New grant</button>}
      </div>
      <Feedback error={grants.error} message={message} />

      {open && (
        <form className="grant-form" onSubmit={submit}>
          <label>User
            <select data-testid="grant-user" value={draft.userId} onChange={(e) => setDraft({ ...draft, userId: e.target.value })}>
              <option value="">choose…</option>
              {members.data?.members.filter((m) => m.user_id !== me.user.id && m.status === 'active').map((m) => (
                <option key={m.user_id} value={m.user_id}>{m.email} ({m.role})</option>
              ))}
            </select>
          </label>
          <label>Scope
            <select data-testid="grant-device" value={draft.deviceId} onChange={(e) => setDraft({ ...draft, deviceId: e.target.value })}>
              <option value="">whole organization</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label>Effect
            <select data-testid="grant-effect" value={draft.effect} onChange={(e) => setDraft({ ...draft, effect: e.target.value })}>
              <option value="allow">allow</option>
              <option value="deny">deny</option>
            </select>
          </label>
          <label>Expires (optional)
            <input type="datetime-local" value={draft.expiresAt} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value })} />
          </label>
          <fieldset className="perm-grid">
            <legend>Permissions</legend>
            {catalogue.map((key) => (
              <label key={key} className="check">
                <input type="checkbox" data-permission-key={key} checked={draft.permissions.includes(key)} onChange={() => toggle(key)} />
                <span className="mono">{key}</span>
              </label>
            ))}
          </fieldset>
          <button data-testid="grant-submit" type="submit">Create grant</button>
        </form>
      )}

      {grants.data && grants.data.grants.length === 0 && <div className="empty">No grants in this organization.</div>}
      {grants.data && grants.data.grants.length > 0 && (
        <table>
          <thead><tr><th>User</th><th>Effect</th><th>Permissions</th><th>Scope</th><th>Window</th><th /></tr></thead>
          <tbody>
            {grants.data.grants.map((g) => (
              <tr key={g.id} data-testid="grant-row" data-grant-id={g.id} data-effect={g.effect}>
                <td className="mono">{nameOf(g.user_id)}</td>
                <td><span className={`pill ${g.effect}`}>{g.effect}</span></td>
                <td className="mono">{g.permissions.join(', ')}</td>
                <td className="mono">{g.device_id ?? 'org-wide'}</td>
                <td className="muted">{g.starts_at ? `from ${new Date(g.starts_at).toLocaleString()} ` : ''}{g.expires_at ? `until ${new Date(g.expires_at).toLocaleString()}` : 'no expiry'}</td>
                <td>
                  {can('grant:revoke') && (
                    <button data-testid="revoke-grant" {...gate('grant:revoke')} className="small danger"
                      onClick={() => run(() => call(`/orgs/${orgId}/grants/${g.id}`, { method: 'DELETE' }).then(grants.reload), 'Grant revoked.')}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
