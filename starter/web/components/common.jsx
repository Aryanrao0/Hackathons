import React, { useCallback, useEffect, useState } from 'react';
import { describe } from '../api.js';

// Load one resource on mount (and on reload()). Each card is keyed by org + card in App,
// so switching org or card remounts it and nothing from the previous view survives.
export function useResource(call, path) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const reload = useCallback(() => {
    setError(null);
    return call(path).then(setData).catch((err) => setError(describe(err)));
  }, [call, path]);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, reload };
}

// Run an action, report its outcome in words. Nothing a user does fails silently.
export function useAction() {
  const [message, setMessage] = useState(null);
  const run = useCallback(async (fn, success) => {
    setMessage(null);
    try {
      await fn();
      if (success) setMessage({ kind: 'ok', text: success });
    } catch (err) {
      setMessage({ kind: 'error', text: describe(err) });
    }
  }, []);
  return { message, run, clear: () => setMessage(null) };
}

export function Feedback({ error, message }) {
  return (
    <>
      {error && <div className="error" role="alert">{error}</div>}
      {message && <div className={message.kind === 'error' ? 'error' : 'ok'} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</div>}
    </>
  );
}

// "Nobody granted this" and "someone denied this" read differently.
export function explain(p) {
  if (!p) return '';
  if (p.effect === 'allow') return p.source?.startsWith('grant:') ? `granted (${p.source.slice(6)})` : `from role ${p.source?.slice(5) ?? ''}`;
  if (p.reason === 'explicit_deny') return `denied by ${p.source?.slice(6)}`;
  if (p.reason === 'suspended') return 'suspended';
  return 'not granted';
}
