import React, { useState } from 'react';
import { allows, gate } from '../presence.js';
import { useResource, useAction, Feedback } from './common.jsx';

// Sessions are records. A row can show an active session on a device whose Control entry
// is now absent: the session is grandfathered on its snapshot; the button answers the
// NEXT request. Those are different questions and are not reconciled here.
export default function Sessions({ call, me, orgId }) {
  const sessions = useResource(call, `/orgs/${orgId}/sessions`);
  const [devices, setDevices] = useState([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ deviceId: '', mode: 'view' });
  const { message, run } = useAction();
  const can = (p) => allows(me.permissions, p);

  function openForm() {
    setOpen((v) => !v);
    call(`/orgs/${orgId}/devices`).then((r) => setDevices(r.devices)).catch(() => setDevices([]));
  }

  function start(e) {
    e.preventDefault();
    run(() => call(`/orgs/${orgId}/sessions`, { method: 'POST', body: draft }).then(() => { setOpen(false); return sessions.reload(); }), 'Session started.');
  }

  function stop(s) {
    run(() => call(`/sessions/${s.id}`, { method: 'DELETE' }).then(sessions.reload), 'Session ended.');
  }

  return (
    <div>
      <div className="panel-head">
        <h2>Sessions</h2>
        {can('session:start') && <button data-testid="new-session" {...gate('session:start')} onClick={openForm}>Start a session</button>}
      </div>
      <Feedback error={sessions.error} message={message} />

      {open && (
        <form className="inline-form" onSubmit={start}>
          <select value={draft.deviceId} onChange={(e) => setDraft({ ...draft, deviceId: e.target.value })}>
            <option value="">device…</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value })}>
            <option value="view">view</option>
            <option value="control">control</option>
            <option value="terminal">terminal</option>
          </select>
          <button type="submit">Start</button>
        </form>
      )}

      {sessions.data && sessions.data.sessions.length === 0 && <div className="empty">No sessions yet.</div>}
      {sessions.data && sessions.data.sessions.length > 0 && (
        <table>
          <thead><tr><th>Device</th><th>User</th><th>Mode</th><th>State</th><th>Expires / ended</th><th /></tr></thead>
          <tbody>
            {sessions.data.sessions.map((s) => {
              const own = s.user_id === me.user.id;
              const live = s.state !== 'ended';
              return (
                <tr key={s.id} data-testid="session-row" data-session-id={s.id} data-state-value={s.state}>
                  <td className="mono">{s.device_id}</td>
                  <td className="mono">{own ? 'you' : s.user_id}</td>
                  <td>{s.mode}</td>
                  <td>{s.state}{s.end_reason ? ` · ${s.end_reason}` : ''}</td>
                  <td className="muted">{new Date(s.ended_at ?? s.expires_at).toLocaleString()}</td>
                  <td>
                    {live && own && (
                      <button data-testid="stop-session" className="small" onClick={() => stop(s)}>Stop</button>
                    )}
                    {live && !own && can('session:terminate') && (
                      <button data-testid="stop-session" {...gate('session:terminate')} className="small danger" onClick={() => stop(s)}>Terminate</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
