import React from 'react';
import { allows, gate } from '../presence.js';
import { useAction, Feedback } from './common.jsx';

// The Admin card is present for org:update OR org:delete; each entry is gated on its own
// permission, which is how an admin sees Rename but not Delete.
export default function Admin({ call, me, orgId, onOrgChanged, onOrgDeleted }) {
  const { message, run } = useAction();
  const can = (p) => allows(me.permissions, p);

  function rename() {
    const name = window.prompt('New organization name', me.org.name);
    if (name === null) return;
    run(() => call(`/orgs/${orgId}`, { method: 'PATCH', body: { name } }).then(onOrgChanged), 'Renamed.');
  }

  function remove() {
    if (!window.confirm(`Delete ${me.org.name}? Every member loses access and live sessions end.`)) return;
    run(() => call(`/orgs/${orgId}`, { method: 'DELETE' }).then(onOrgDeleted));
  }

  return (
    <div>
      <div className="panel-head"><h2>Admin</h2></div>
      <Feedback message={message} />
      <dl className="facts">
        <dt>Organization</dt><dd>{me.org.name}</dd>
        <dt>Theme</dt><dd className="mono">{me.org.theme}</dd>
        <dt>Session limit</dt><dd>{me.org.maxSessionMinutes} minutes</dd>
      </dl>
      <div className="actions">
        {can('org:update') && <button data-testid="rename-org" {...gate('org:update')} onClick={rename}>Rename organization</button>}
        {can('org:delete') && <button data-testid="delete-org" {...gate('org:delete')} className="danger" onClick={remove}>Delete organization</button>}
      </div>
    </div>
  );
}
