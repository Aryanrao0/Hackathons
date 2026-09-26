// Shared domain rules: role ranks, last-owner protection, ending sessions.
//
// Rules more than one route needs live here, so "what ends a session" and "who may modify
// whom" each have exactly one implementation.
//
// `roles.rank` is MODIFICATION AUTHORITY ONLY. Nothing in this file answers a can()
// question; that is permissions.js. And no role is named here: the "owner" role is whichever
// role has the highest rank in the table, so a fixture with different role keys still works.

import { badRequest, forbidden, lastOwner } from './http.js';
import { nowIso } from './db.js';
import { resolve } from './permissions.js';

export function roleRanks(db) {
  return new Map(db.prepare('SELECT key, rank FROM roles').all().map((r) => [r.key, r.rank]));
}

// The role that owns an org: the top of the modification order.
export function ownerRole(db) {
  return db.prepare('SELECT key FROM roles ORDER BY rank DESC LIMIT 1').get().key;
}

export function assertRoleExists(db, role) {
  if (typeof role !== 'string' || !roleRanks(db).has(role)) {
    throw badRequest('role is not one of the roles in this system', 'unknown_role');
  }
}

// You may modify someone strictly below you. Equal rank is refused (admin -> admin) — except
// for the owner role: owners may modify other owners, or a second owner could never be
// demoted or removed. assertNotLastOwner is what stops that from emptying the org.
export function assertCanModify(db, callerRole, targetRole) {
  const ranks = roleRanks(db);
  if (callerRole === ownerRole(db)) return;
  if (!(ranks.get(callerRole) > ranks.get(targetRole))) {
    throw forbidden('you can only modify members ranked below you', 'insufficient_rank');
  }
}

// You may hand out a role strictly below your own; only the owner role may confer itself.
// Used for role changes and invites alike, so the two can never disagree.
export function assertCanAssign(db, callerRole, newRole) {
  const ranks = roleRanks(db);
  const owner = ownerRole(db);
  if (newRole === owner && callerRole === owner) return;
  if (!(ranks.get(callerRole) > ranks.get(newRole))) {
    throw forbidden(`you cannot assign the ${newRole} role`, 'insufficient_rank');
  }
}

// Refuses a change that would leave the org without an ACTIVE owner. Call it before
// demoting, suspending, removing or letting leave anyone who currently holds the owner role.
export function assertNotLastOwner(db, orgId, userId) {
  const owner = ownerRole(db);
  const target = db.prepare('SELECT role, status FROM memberships WHERE org_id = ? AND user_id = ?').get(orgId, userId);
  if (!target || target.role !== owner || target.status !== 'active') return;
  const { n } = db.prepare(
    "SELECT count(*) AS n FROM memberships WHERE org_id = ? AND role = ? AND status = 'active'"
  ).get(orgId, owner);
  if (n <= 1) throw lastOwner();
}

// The one implementation of "end sessions". Any combination of user / device narrows it.
// Returns the number of sessions ended.
export function endActiveSessions(db, { orgId, userId = null, deviceId = null, reason, exceptSessionId = null }) {
  return db.prepare(
    `UPDATE sessions SET state = 'ended', end_reason = ?, ended_at = ?
      WHERE org_id = ? AND state IN ('active','connecting')
        AND (? IS NULL OR user_id = ?)
        AND (? IS NULL OR device_id = ?)
        AND (? IS NULL OR id != ?)`
  ).run(reason, nowIso(), orgId, userId, userId, deviceId, deviceId, exceptSessionId, exceptSessionId).changes;
}

// Sessions past their TTL are ended lazily, before anything reads sessions or tries to open
// one. Without this, an expired control session would still hold the partial unique index
// and block the device forever.
export function expireSessions(db, orgId) {
  const now = nowIso();
  return db.prepare(
    `UPDATE sessions SET state = 'ended', end_reason = 'session_expired', ended_at = expires_at
      WHERE org_id = ? AND state IN ('active','connecting') AND expires_at <= ?`
  ).run(orgId, now).changes;
}

// What authorised the session, frozen at start. Sessions are grandfathered on this, not on
// whatever the grants say later.
export function snapshotAuthority(db, { userId, orgId, deviceId }) {
  const { role, permissions } = resolve(db, { userId, orgId, deviceId });
  const grantIds = [...new Set(
    Object.values(permissions)
      .map((p) => p.source)
      .filter((s) => s?.startsWith('grant:'))
      .map((s) => s.slice('grant:'.length))
  )];
  const allowed = Object.keys(permissions).filter((k) => permissions[k].effect === 'allow');
  return { role, grantIds, permissions: allowed, snapshotAt: nowIso() };
}

export function sessionExpiry(db, orgId) {
  const { max_session_minutes: minutes } = db.prepare('SELECT max_session_minutes FROM organizations WHERE id = ?').get(orgId);
  return new Date(Date.now() + minutes * 60_000).toISOString();
}
