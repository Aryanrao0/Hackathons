// Per-request context: turn a bearer token into an authenticated caller.
//
// The order of the checks is the design:
//   1. verify the token (401)
//   2. the org in the path must be the token's org, or the resource is INVISIBLE (404).
//      This runs before any lookup, so another org's existence is never probed.
//   3. the membership must still exist and not be removed (401)
//   4. the token's pv must equal memberships.perm_version (401 TOKEN_STALE)
//   5. a suspended membership reaches only the few routes that are about the person rather
//      than the org (403 suspended everywhere else)

import { verifyAccessToken, assertFresh } from './auth.js';
import { unauthenticated, notFound, forbidden } from './http.js';

// Routes a suspended member may still use: leave, see and switch their orgs, create one.
// Everything else in the suspended org is refused, including routes no permission gates.
const SUSPENDED_OK = new Set([
  'POST /v1/auth/token',
  'GET /v1/orgs',
  'POST /v1/orgs',
  'DELETE /v1/orgs/:org/members/me',
]);

function bearer(req) {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match) throw unauthenticated('missing bearer token');
  return match[1];
}

export function authenticate(db, secret) {
  const findMembership = db.prepare(
    `SELECT m.id, m.org_id, m.user_id, m.role, m.status, m.perm_version
       FROM memberships m
       JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
      WHERE m.org_id = ? AND m.user_id = ?`
  );

  return function buildContext(req, params, routeKey = '') {
    const claims = verifyAccessToken(bearer(req), secret);

    if (params.org !== undefined && params.org !== claims.org) throw notFound();

    const membership = findMembership.get(claims.org, claims.sub);
    if (!membership || membership.status === 'removed' || membership.status === 'invited') {
      throw unauthenticated('no longer a member of this org');
    }
    assertFresh(claims, membership);

    if (membership.status === 'suspended' && !SUSPENDED_OK.has(routeKey)) {
      throw forbidden('your membership in this org is suspended', 'suspended');
    }

    return {
      userId: claims.sub,
      orgId: claims.org,
      role: membership.role,   // from the database, not the claim
      membership,
      claims,
    };
  };
}
