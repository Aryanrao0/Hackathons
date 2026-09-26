// The one place the console talks to the server.
//
// The access token is held by the caller (React state) and passed in — never written to
// localStorage/sessionStorage. The refresh token is an httpOnly cookie the browser sends to
// /v1/auth/* on its own; this code never sees it.

export class ApiError extends Error {
  constructor(status, { code, message, reason, requestId } = {}) {
    super(message || `request failed (${status})`);
    this.status = status;
    this.code = code ?? 'UNKNOWN';
    this.reason = reason ?? null;
    this.requestId = requestId ?? null;
  }
}

export async function request(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res;
  try {
    res = await fetch(`/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    // A network-level failure: the server is down or unreachable. Say so.
    throw new ApiError(0, { code: 'UNREACHABLE', message: 'Cannot reach the server. Is it running?' });
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }

  if (!res.ok) {
    if (json?.error) throw new ApiError(res.status, json.error);
    throw new ApiError(res.status, { code: 'BAD_RESPONSE', message: `The server answered ${res.status} without an explanation.` });
  }
  return json;
}

// One refresh in flight at a time. Two concurrent refreshes would present the same cookie
// twice, and the server rightly treats the second as a replay and revokes the family.
let refreshing = null;
export function refreshSession(orgId) {
  refreshing ??= request('/auth/refresh', { method: 'POST', body: orgId ? { orgId } : {} })
    .finally(() => { refreshing = null; });
  return refreshing;
}

// Human text for an error, carrying the server's own words and code.
export function describe(err) {
  if (!(err instanceof ApiError)) return String(err?.message ?? err);
  return err.reason ? `${err.message} (${err.code}: ${err.reason})` : `${err.message} (${err.code})`;
}
