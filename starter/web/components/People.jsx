import React, { useState } from 'react';
import { allows, gate } from '../presence.js';
import { useResource, useAction, Feedback } from './common.jsx';

// Members of the active org. Management entries appear per the caller's permissions; the
// rank rules (who may modify whom) are the server's, and a refusal is shown in its words.
export default function People({ call, me, orgId }) {
  const members = useResource(call, `/orgs/${orgId}/members`);
  const roles = useResource(call, '/roles');
  const { message, run } = useAction();
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState({ email: '', role: '' });
  const [lastToken, setLastToken] = useState(null);
  const can = (p) => allows(me.permissions, p);
  const roleKeys = roles.data?.roles.map((r) => r.key) ?? [];

  const act = (fn, ok) => run(() => fn().then(members.reload), ok);

  function sendInvite(e) {
    e.preventDefault();
    run(async () => {
      const created = await call(`/orgs/${orgId}/invites`, { method: 'POST', body: { email: invite.email, role: invite.role || roleKeys[roleKeys.length - 1] } });
      setLastToken(created.inviteToken);
      setInviting(false);
    }, 'Invite created. The link below is shown once.');
  }

  return (
    <div>
      <div className="panel-head">
        <h2>People</h2>
        {can('user:invite') && (
          <button data-testid="invite-user" {...gate('user:invite')} onClick={() => setInviting((v) => !v)}>Invite</button>
        )}
      </div>
      <Feedback error={members.error} message={message} />
      {lastToken && (
        <div className="ok mono">Invite link: {`${window.location.origin}/invite/${lastToken}`}</div>
      )}

      {inviting && (
        <form className="inline-form" onSubmit={sendInvite}>
          <input placeholder="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
          <select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
            <option value="">role…</option>
            {roleKeys.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button type="submit">Send</button>
        </form>
      )}

      {members.data && (
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {members.data.members.map((m) => {
              const self = m.user_id === me.user.id;
              return (
                <tr key={m.user_id} data-testid="user-row" data-user-id={m.user_id}>
                  <td>{m.name}{self ? ' (you)' : ''}</td>
                  <td className="mono">{m.email}</td>
                  <td>
                    {can('user:role:update') && !self ? (
                      <select data-testid="role-select" {...gate('user:role:update')} value={m.role}
                        onChange={(e) => act(() => call(`/orgs/${orgId}/members/${m.user_id}`, { method: 'PATCH', body: { role: e.target.value } }), 'Role changed.')}>
                        {(roleKeys.includes(m.role) ? roleKeys : [m.role, ...roleKeys]).map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    ) : m.role}
                  </td>
                  <td>{m.status}</td>
                  <td className="actions">
                    {can('user:remove') && !self && (
                      <button data-testid="suspend-user" {...gate('user:remove')} className="small"
                        onClick={() => act(() => call(`/orgs/${orgId}/members/${m.user_id}/suspend`, { method: m.status === 'suspended' ? 'DELETE' : 'POST' }),
                          m.status === 'suspended' ? 'Reinstated.' : 'Suspended; their sessions here have ended.')}>
                        {m.status === 'suspended' ? 'Reinstate' : 'Suspend'}
                      </button>
                    )}
                    {can('user:remove') && !self && (
                      <button data-testid="remove-user" {...gate('user:remove')} className="small danger"
                        onClick={() => window.confirm(`Remove ${m.email} from this org?`) && act(() => call(`/orgs/${orgId}/members/${m.user_id}`, { method: 'DELETE' }), 'Removed.')}>
                        Remove
                      </button>
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
