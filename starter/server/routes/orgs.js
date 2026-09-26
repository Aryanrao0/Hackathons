// Orgs, members, effective permissions, and the audit log.
//
// Membership changes share one shape: permission gate -> target must be a member (404) ->
// rank and last-owner rules (lifecycle.js) -> change + perm_version bump + audit row in one
// transaction. Users are never deleted; removal is a membership status.

import { send, badRequest, notFound, conflict, forbidden, selfRoleChange } from '../http.js';
import { newId, nowIso, bumpPermVersion } from '../db.js';
import { resolve, assertCan } from '../permissions.js';
import {
  ownerRole, assertRoleExists, assertCanModify, assertCanAssign,
  assertNotLastOwner, endActiveSessions,
} from '../lifecycle.js';
import { audit } from '../audit.js';
import { listOrgs } from './auth.js';

// Known themes first, so the first few orgs a person makes all look different. Any theme
// string in the database still renders: the console hashes unknown ones to a colour.
const THEMES = ['cobalt', 'amber', 'moss', 'plum', 'rust', 'teal'];
const NAME_MAX = 80;

export function requireName(value, field = 'name') {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${field} is required`);
  const name = value.trim();
  if (name.length > NAME_MAX) throw badRequest(`${field} must be at most ${NAME_MAX} characters`);
  return name;
}

// A member of THIS org (active or suspended). Removed members are gone as far as the org's
// API is concerned, and a user from elsewhere is invisible.
function findMember(db, orgId, userId) {
  const m = db.prepare(
    `SELECT m.user_id, m.role, m.status, m.joined_at, u.email, u.name
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? AND m.user_id = ? AND m.status IN ('active','suspended')`
  ).get(orgId, userId);
  if (!m) throw notFound();
  return m;
}

const tx = (db, fn) => db.transaction(fn)();

// Parse a non-negative integer query parameter strictly: '10abc', '1.5' and '' are all 400.
function intParam(query, name, { def, min, max }) {
  const raw = query.get(name);
  if (raw === null) return def;
  if (!/^-?\d+$/.test(raw)) throw badRequest(`${name} must be an integer`);
  const n = Number(raw);
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return n;
}

// Offboarding in one place: status, version bump, sessions, and the user's grants here. The
// grants are revoked so a rehire starts from the invited role, not from old authority.
function removeMembership(db, ctx, orgId, userId, action) {
  db.prepare("UPDATE memberships SET status = 'removed' WHERE org_id = ? AND user_id = ?").run(orgId, userId);
  bumpPermVersion(db, { orgId, userId });
  endActiveSessions(db, { orgId, userId, reason: 'membership_removed' });
  db.prepare('UPDATE grants SET revoked_at = ? WHERE org_id = ? AND user_id = ? AND revoked_at IS NULL').run(nowIso(), orgId, userId);
  audit(db, { orgId, actorId: ctx.userId, action, targetType: 'user', targetId: userId, requestId: ctx.requestId });
}

export function orgRoutes(on, { db }) {
  const member = (p) => ({ targetType: 'user', targetId: p.userId });

  // The role list the console offers in its selects. Read from the table so the console
  // never carries its own copy — an undocumented role shows up here like any other.
  on('get', '/v1/roles', 'role.list', (ctx, _p, res) => {
    send(res, 200, { roles: db.prepare('SELECT key, label, rank FROM roles ORDER BY rank DESC').all() });
  });

  // --- orgs -------------------------------------------------------------------

  on('get', '/v1/orgs', 'org.list', (ctx, _p, res) => {
    send(res, 200, { orgs: listOrgs(db, ctx.userId) });
  });

  on('post', '/v1/orgs', 'org.create', (ctx, _p, res) => {
    const name = requireName(ctx.body.name);
    const mine = listOrgs(db, ctx.userId);
    if (mine.some((o) => o.name.toLowerCase() === name.toLowerCase())) throw conflict('you already belong to an org with that name');
    const theme = THEMES.find((t) => !mine.some((o) => o.theme === t)) ?? THEMES[mine.length % THEMES.length];
    const owner = ownerRole(db);

    const org = tx(db, () => {
      const id = newId('org');
      db.prepare('INSERT INTO organizations (id, name, theme) VALUES (?,?,?)').run(id, name, theme);
      db.prepare("INSERT INTO memberships (id, org_id, user_id, role, status, joined_at) VALUES (?,?,?,?,'active',?)")
        .run(newId('mem'), id, ctx.userId, owner, nowIso());
      audit(db, { orgId: id, actorId: ctx.userId, action: 'org.create', targetType: 'org', targetId: id, requestId: ctx.requestId });
      return { id, name, theme, role: owner };
    });
    send(res, 201, org);
  });

  on('patch', '/v1/orgs/:org', 'org.update', (ctx, p, res) => {
    assertCan(db, ctx, 'org:update');
    const { name, maxSessionMinutes } = ctx.body;
    const updates = {};
    if (name !== undefined) updates.name = requireName(name);
    if (maxSessionMinutes !== undefined) {
      if (!Number.isInteger(maxSessionMinutes) || maxSessionMinutes < 1 || maxSessionMinutes > 1440) {
        throw badRequest('maxSessionMinutes must be an integer between 1 and 1440');
      }
      updates.max_session_minutes = maxSessionMinutes;
    }
    if (!Object.keys(updates).length) throw badRequest('nothing to update');

    tx(db, () => {
      for (const [col, val] of Object.entries(updates)) {
        db.prepare(`UPDATE organizations SET ${col} = ? WHERE id = ?`).run(val, p.org);
      }
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'org.update', targetType: 'org', targetId: p.org, requestId: ctx.requestId });
    });
    const org = db.prepare('SELECT id, name, theme, max_session_minutes FROM organizations WHERE id = ?').get(p.org);
    send(res, 200, org);
  });

  on('delete', '/v1/orgs/:org', 'org.delete', (ctx, p, res) => {
    assertCan(db, ctx, 'org:delete');
    tx(db, () => {
      db.prepare('UPDATE organizations SET deleted_at = ? WHERE id = ?').run(nowIso(), p.org);
      endActiveSessions(db, { orgId: p.org, reason: 'admin_terminated' });
      // Every member's token for this org dies on its next use.
      db.prepare('UPDATE memberships SET perm_version = perm_version + 1 WHERE org_id = ?').run(p.org);
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'org.delete', targetType: 'org', targetId: p.org, requestId: ctx.requestId });
    });
    send(res, 204);
  });

  // --- members ----------------------------------------------------------------

  on('get', '/v1/orgs/:org/members', 'member.list', (ctx, p, res) => {
    assertCan(db, ctx, 'user:read');
    const members = db.prepare(
      `SELECT m.user_id, u.email, u.name, m.role, m.status, m.joined_at
         FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ? AND m.status IN ('active','suspended')
        ORDER BY u.name, u.id`
    ).all(p.org);
    send(res, 200, { members });
  });

  // Registered before '/members/:userId' — same segment count, first match wins.
  on('delete', '/v1/orgs/:org/members/me', 'member.leave', (ctx, p, res) => {
    tx(db, () => {
      assertNotLastOwner(db, p.org, ctx.userId);
      removeMembership(db, ctx, p.org, ctx.userId, 'member.leave');
    });
    send(res, 204);
  });

  on('patch', '/v1/orgs/:org/members/:userId', 'member.role_update', (ctx, p, res) => {
    assertCan(db, ctx, 'user:role:update');
    if (p.userId === ctx.userId) throw selfRoleChange();
    const target = findMember(db, p.org, p.userId);
    const { role } = ctx.body;
    assertRoleExists(db, role);
    assertCanModify(db, ctx.role, target.role);
    assertCanAssign(db, ctx.role, role);

    tx(db, () => {
      if (role !== target.role) assertNotLastOwner(db, p.org, p.userId);
      db.prepare('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?').run(role, p.org, p.userId);
      bumpPermVersion(db, { orgId: p.org, userId: p.userId });
      // Deliberately NOT ending sessions: a role change is a permission change, and live
      // sessions are grandfathered on their snapshot until their TTL.
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'member.role_update', targetType: 'user', targetId: p.userId, requestId: ctx.requestId });
    });
    send(res, 200, findMember(db, p.org, p.userId));
  }, member);

  on('post', '/v1/orgs/:org/members/:userId/suspend', 'member.suspend', (ctx, p, res) => {
    assertCan(db, ctx, 'user:remove');
    if (p.userId === ctx.userId) throw forbidden('you cannot suspend yourself', 'self');
    const target = findMember(db, p.org, p.userId);
    assertCanModify(db, ctx.role, target.role);
    if (target.status === 'suspended') throw conflict('member is already suspended');

    tx(db, () => {
      assertNotLastOwner(db, p.org, p.userId);
      db.prepare("UPDATE memberships SET status = 'suspended' WHERE org_id = ? AND user_id = ?").run(p.org, p.userId);
      bumpPermVersion(db, { orgId: p.org, userId: p.userId });
      endActiveSessions(db, { orgId: p.org, userId: p.userId, reason: 'user_suspended' });
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'member.suspend', targetType: 'user', targetId: p.userId, requestId: ctx.requestId });
    });
    send(res, 200, findMember(db, p.org, p.userId));
  }, member);

  on('delete', '/v1/orgs/:org/members/:userId/suspend', 'member.reinstate', (ctx, p, res) => {
    assertCan(db, ctx, 'user:remove');
    const target = findMember(db, p.org, p.userId);
    assertCanModify(db, ctx.role, target.role);
    if (target.status !== 'suspended') throw conflict('member is not suspended');

    tx(db, () => {
      db.prepare("UPDATE memberships SET status = 'active' WHERE org_id = ? AND user_id = ?").run(p.org, p.userId);
      bumpPermVersion(db, { orgId: p.org, userId: p.userId });
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'member.reinstate', targetType: 'user', targetId: p.userId, requestId: ctx.requestId });
    });
    send(res, 200, findMember(db, p.org, p.userId));
  }, member);

  on('delete', '/v1/orgs/:org/members/:userId', 'member.remove', (ctx, p, res) => {
    assertCan(db, ctx, 'user:remove');
    if (p.userId === ctx.userId) throw badRequest('use DELETE /members/me to leave an org');
    const target = findMember(db, p.org, p.userId);
    assertCanModify(db, ctx.role, target.role);
    tx(db, () => {
      assertNotLastOwner(db, p.org, p.userId);
      removeMembership(db, ctx, p.org, p.userId, 'member.remove');
    });
    send(res, 204);
  }, member);

  // --- effective permissions --------------------------------------------------

  on('get', '/v1/orgs/:org/users/:userId/effective', 'member.effective', (ctx, p, res) => {
    if (p.userId !== ctx.userId) assertCan(db, ctx, 'user:read');
    findMember(db, p.org, p.userId);
    const deviceId = ctx.query.get('deviceId');
    if (deviceId && !db.prepare('SELECT 1 FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(deviceId, p.org)) {
      throw notFound();
    }
    const { role, permissions } = resolve(db, { userId: p.userId, orgId: p.org, deviceId: deviceId || null });
    send(res, 200, { role, permissions });
  }, member);

  // --- audit ------------------------------------------------------------------

  on('get', '/v1/orgs/:org/audit', 'audit.read', (ctx, p, res) => {
    assertCan(db, ctx, 'audit:read');
    const limit = intParam(ctx.query, 'limit', { def: 50, min: 1, max: 500 });
    const offset = intParam(ctx.query, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
    const events = db.prepare(
      `SELECT id, actor_id, action, target_type, target_id, result, reason_code, request_id, at
         FROM audit_events WHERE org_id = ? ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`
    ).all(p.org, limit, offset);
    send(res, 200, { events, limit, offset });
  });
}
