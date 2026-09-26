import React from 'react';
import { useResource, Feedback } from './common.jsx';

// Append-only history, including refusals. Read-only by construction: there is no API to
// change it, and the database triggers would refuse if there were.
export default function Audit({ call, orgId }) {
  const { data, error } = useResource(call, `/orgs/${orgId}/audit?limit=200`);
  return (
    <div>
      <div className="panel-head"><h2>Audit log</h2></div>
      <Feedback error={error} />
      {data && data.events.length === 0 && <div className="empty">Nothing recorded yet.</div>}
      {data && data.events.length > 0 && (
        <table>
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Result</th></tr></thead>
          <tbody>
            {data.events.map((e) => (
              <tr key={e.id} data-testid="audit-row" data-result={e.result}>
                <td className="muted">{new Date(e.at).toLocaleString()}</td>
                <td className="mono">{e.actor_id}</td>
                <td className="mono">{e.action}</td>
                <td className="mono">{e.target_type ? `${e.target_type} ${e.target_id ?? ''}` : ''}</td>
                <td><span className={`pill ${e.result}`}>{e.result}</span>{e.reason_code ? <span className="muted"> {e.reason_code}</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
