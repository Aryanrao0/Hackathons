import React, { useState } from 'react';
import { allows, gate } from '../presence.js';
import { useResource, useAction, Feedback } from './common.jsx';

const KINDS = ['macos', 'windows', 'linux', 'android', 'ios'];

// Every row carries the caller's resolved permissions for THAT device (the server sends
// them), so each entry is decided per row: a one-device grant lights exactly one row.
const ROW_ENTRIES = [
  { testid: 'start-view', permission: 'device:view', label: 'View', mode: 'view' },
  { testid: 'start-control', permission: 'device:control', label: 'Control', mode: 'control' },
  { testid: 'start-terminal', permission: 'device:terminal', label: 'Terminal', mode: 'terminal' },
  { testid: 'transfer-files', permission: 'device:file_transfer', label: 'Transfer files' },
  { testid: 'rename-device', permission: 'device:update', label: 'Rename' },
  { testid: 'decommission-device', permission: 'device:provision', label: 'Decommission' },
];

export default function Devices({ call, me, orgId }) {
  const { data, error, reload } = useResource(call, `/orgs/${orgId}/devices`);
  const { message, run } = useAction();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: '', kind: 'linux' });

  function act(device, entry) {
    if (entry.mode) {
      return run(() => call(`/orgs/${orgId}/sessions`, { method: 'POST', body: { deviceId: device.id, mode: entry.mode } }),
        `${entry.label} session started on ${device.name}.`);
    }
    if (entry.testid === 'transfer-files') {
      return run(async () => { throw new Error('File transfer is out of scope: sessions are records, nothing is moved.'); });
    }
    if (entry.testid === 'rename-device') {
      const name = window.prompt('New name', device.name);
      if (name === null) return;
      return run(() => call(`/orgs/${orgId}/devices/${device.id}`, { method: 'PATCH', body: { name } }).then(reload), 'Renamed.');
    }
    if (entry.testid === 'decommission-device') {
      if (!window.confirm(`Decommission ${device.name}? Its live sessions end.`)) return;
      return run(() => call(`/orgs/${orgId}/devices/${device.id}`, { method: 'DELETE' }).then(reload), 'Decommissioned.');
    }
  }

  function add(e) {
    e.preventDefault();
    run(() => call(`/orgs/${orgId}/devices`, { method: 'POST', body: draft }).then(() => {
      setAdding(false);
      setDraft({ name: '', kind: 'linux' });
      return reload();
    }), 'Device added.');
  }

  return (
    <div>
      <div className="panel-head">
        <h2>Devices</h2>
        {allows(me.permissions, 'device:provision') && (
          <button data-testid="add-device" {...gate('device:provision')} onClick={() => setAdding((v) => !v)}>Add device</button>
        )}
      </div>
      <Feedback error={error} message={message} />

      {adding && (
        <form className="inline-form" onSubmit={add}>
          <input placeholder="name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
            {KINDS.map((k) => <option key={k}>{k}</option>)}
          </select>
          <button type="submit">Add</button>
        </form>
      )}

      {data && data.devices.length === 0 && <div className="empty" data-testid="devices-empty">No devices in this organization yet.</div>}
      {data && data.devices.length > 0 && (
        <table>
          <thead><tr><th>Name</th><th>Kind</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {data.devices.map((d) => (
              <tr key={d.id} data-testid="device-row" data-device-id={d.id}>
                <td className="mono">{d.name}</td>
                <td>{d.kind}</td>
                <td><span className={d.online ? 'dot on' : 'dot'} /> {d.online ? 'online' : 'offline'}</td>
                <td className="actions">
                  {ROW_ENTRIES.filter((e) => allows(d.permissions, e.permission)).map((e) => (
                    <button key={e.testid} data-testid={e.testid} {...gate(e.permission)} className="small" onClick={() => act(d, e)}>
                      {e.label}
                    </button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
