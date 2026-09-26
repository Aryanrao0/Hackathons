// Devices and grants.
//
// A device outside the caller's org, soft-deleted, or non-existent is the same 404.
// device:list gates the list; device:view on each device decides whether its row exists at
// all. Each row carries the caller's resolved set for THAT device, from one batched
// resolveDevices() call, so the console never asks per row and never re-derives the rules.

import { send, badRequest, notFound, conflict, forbidden, HttpError, normalizeTs } from '../http.js';
import { newId, nowIso, bumpPermVersion } from '../db.js';
import { resolve, resolveDevices, assertCan, assertMayGrant } from '../permissions.js';
import { endActiveSessions } from '../lifecycle.js';
import { audit } from '../audit.js';
import { requireName } from './orgs.js';

const KINDS = ['macos', 'windows', 'linux', 'android', 'ios'];
const tx = (db, fn) => db.transaction(fn)();

const toRow = (d, permissions) => ({ id: d.id, name: d.name, kind: d.kind, online: d.online === 1, permissions });

function findDevice(db, orgId, id) {
  const d = db.prepare('SELECT id, org_id, name, kind, online FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(id, orgId);
  if (!d) throw notFound();
  return d;
}

function assertNameFree(db, orgId, name, exceptId = null) {
  const clash = db.prepare(
    'SELECT 1 FROM devices WHERE org_id = ? AND lower(name) = lower(?) AND deleted_at IS NULL AND id IS NOT ?'
  ).get(orgId, name, exceptId);
  if (clash) throw conflict('a device with that name already exists in this org');
}

const grantPermissions = (db, ids) => {
  const byGrant = Object.fromEntries(ids.map((id) => [id, []]));
  if (!ids.length) return byGrant;
  const rows = db.prepare(
    `SELECT grant_id, permission FROM grant_permissions WHERE grant_id IN (${ids.map(() => '?').join(',')}) ORDER BY permission`
  ).all(...ids);
  for (const r of rows) byGrant[r.grant_id].push(r.permission);
  return byGrant;
};

export function deviceRoutes(on, { db }) {
  const device = (p) => ({ targetType: 'device', targetId: p.id });

  // --- devices ----------------------------------------------------------------

  on('get', '/v1/orgs/:org/devices', 'device.list', (ctx, p, res) => {
    assertCan(db, ctx, 'device:list');
    const devices = db.prepare(
      'SELECT id, name, kind, online FROM devices WHERE org_id = ? AND deleted_at IS NULL ORDER BY name, id'
    ).all(p.org);
    const { byDevice } = resolveDevices(db, { userId: ctx.userId, orgId: p.org, deviceIds: devices.map((d) => d.id) });
    const rows = devices
      .filter((d) => byDevice[d.id]['device:view'].effect === 'allow')   // absent, not redacted
      .map((d) => toRow(d, byDevice[d.id]));
    send(res, 200, { devices: rows });
  });

  on('get', '/v1/orgs/:org/devices/:id', 'device.view', (ctx, p, res) => {
    const d = findDevice(db, p.org, p.id);
    assertCan(db, ctx, 'device:view', d.id);
    const { permissions } = resolve(db, { userId: ctx.userId, orgId: p.org, deviceId: d.id });
    send(res, 200, toRow(d, permissions));
  }, device);

  on('post', '/v1/orgs/:org/devices', 'device.provision', (ctx, p, res) => {
    assertCan(db, ctx, 'device:provision');
    const name = requireName(ctx.body.name);
    const { kind, online = false } = ctx.body;
    if (!KINDS.includes(kind)) throw badRequest(`kind must be one of ${KINDS.join(', ')}`);
    if (typeof online !== 'boolean') throw badRequest('online must be a boolean');
    assertNameFree(db, p.org, name);

    const id = newId('dev');
    tx(db, () => {
      db.prepare('INSERT INTO devices (id, org_id, name, kind, online) VALUES (?,?,?,?,?)').run(id, p.org, name, kind, online ? 1 : 0);
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'device.provision', targetType: 'device', targetId: id, requestId: ctx.requestId });
    });
    const { permissions } = resolve(db, { userId: ctx.userId, orgId: p.org, deviceId: id });
    send(res, 201, toRow(findDevice(db, p.org, id), permissions));
  });

  on('patch', '/v1/orgs/:org/devices/:id', 'device.update', (ctx, p, res) => {
    const d = findDevice(db, p.org, p.id);
    assertCan(db, ctx, 'device:update', d.id);
    const name = requireName(ctx.body.name);
    assertNameFree(db, p.org, name, d.id);
    tx(db, () => {
      db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, d.id);
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'device.update', targetType: 'device', targetId: d.id, requestId: ctx.requestId });
    });
    const { permissions } = resolve(db, { userId: ctx.userId, orgId: p.org, deviceId: d.id });
    send(res, 200, toRow(findDevice(db, p.org, d.id), permissions));
  }, device);

  on('delete', '/v1/orgs/:org/devices/:id', 'device.decommission', (ctx, p, res) => {
    const d = findDevice(db, p.org, p.id);
    assertCan(db, ctx, 'device:provision', d.id);
    tx(db, () => {
      db.prepare('UPDATE devices SET deleted_at = ? WHERE id = ?').run(nowIso(), d.id);
      endActiveSessions(db, { orgId: p.org, deviceId: d.id, reason: 'device_transferred' });
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'device.decommission', targetType: 'device', targetId: d.id, requestId: ctx.requestId });
    });
    send(res, 204);
  }, device);

  // Needs device:provision in BOTH orgs. The caller's token only speaks for the source org,
  // so the target side is resolved from their membership there — no membership, no org (404).
  on('post', '/v1/orgs/:org/devices/:id/transfer', 'device.transfer', (ctx, p, res) => {
    const d = findDevice(db, p.org, p.id);
    assertCan(db, ctx, 'device:provision', d.id);
    const { targetOrgId } = ctx.body;
    if (typeof targetOrgId !== 'string' || !targetOrgId) throw badRequest('targetOrgId is required');
    if (targetOrgId === p.org) throw badRequest('the device is already in that org');

    const target = resolve(db, { userId: ctx.userId, orgId: targetOrgId });
    if (target.role === null) throw notFound();   // not a member there, or no such org
    if (target.permissions['device:provision'].effect !== 'allow') {
      throw forbidden('device:provision is required in the target org', 'missing_permission');
    }

    tx(db, () => {
      db.prepare('UPDATE devices SET org_id = ? WHERE id = ?').run(targetOrgId, d.id);
      endActiveSessions(db, { orgId: p.org, deviceId: d.id, reason: 'device_transferred' });
      // Grants on this device belong to the old org. Revoke them rather than leave them
      // inert: if the device ever came back, they would silently come back with it.
      const affected = db.prepare('SELECT DISTINCT user_id FROM grants WHERE org_id = ? AND device_id = ? AND revoked_at IS NULL').all(p.org, d.id);
      db.prepare('UPDATE grants SET revoked_at = ? WHERE org_id = ? AND device_id = ? AND revoked_at IS NULL').run(nowIso(), p.org, d.id);
      for (const { user_id: userId } of affected) bumpPermVersion(db, { orgId: p.org, userId });
      for (const orgId of [p.org, targetOrgId]) {
        audit(db, { orgId, actorId: ctx.userId, action: 'device.transfer', targetType: 'device', targetId: d.id, requestId: ctx.requestId });
      }
    });
    send(res, 200, { id: d.id, orgId: targetOrgId });
  }, device);

  // --- grants -----------------------------------------------------------------

  on('get', '/v1/orgs/:org/grants', 'grant.list', (ctx, p, res) => {
    assertCan(db, ctx, 'user:read');
    const userId = ctx.query.get('userId');
    const grants = db.prepare(
      `SELECT id, user_id, device_id, effect, starts_at, expires_at, created_by, created_at
         FROM grants WHERE org_id = ? AND revoked_at IS NULL AND (? IS NULL OR user_id = ?)
        ORDER BY created_at, id`
    ).all(p.org, userId, userId);
    const perms = grantPermissions(db, grants.map((g) => g.id));
    send(res, 200, { grants: grants.map((g) => ({ ...g, permissions: perms[g.id] })) });
  });

  on('post', '/v1/orgs/:org/grants', 'grant.create', (ctx, p, res) => {
    const { userId, deviceId = null, effect, permissions } = ctx.body;

    // Shape first: these are 400s whoever is asking.
    if (!Array.isArray(permissions) || permissions.length === 0 || !permissions.every((x) => typeof x === 'string')) {
      throw badRequest('permissions must be a non-empty array of strings');
    }
    if (effect !== 'allow' && effect !== 'deny') throw badRequest('effect must be allow or deny');
    if (typeof userId !== 'string') throw badRequest('userId is required');
    const startsAt = normalizeTs(ctx.body.startsAt, 'startsAt');
    const expiresAt = normalizeTs(ctx.body.expiresAt, 'expiresAt');
    if (startsAt && expiresAt && expiresAt <= startsAt) throw badRequest('expiresAt must be after startsAt');
    if (expiresAt && expiresAt <= nowIso()) throw new HttpError(400, 'GRANT_EXPIRED', 'expiresAt is already in the past', 'expired_grant');

    // Then visibility (404), then authority (403).
    if (deviceId !== null) findDevice(db, p.org, deviceId);
    const target = db.prepare("SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ? AND status = 'active'").get(p.org, userId);
    if (!target) throw notFound();
    assertCan(db, ctx, 'grant:create', deviceId);
    if (userId === ctx.userId) throw forbidden('you cannot grant to yourself', 'self_grant');
    assertMayGrant(db, ctx, permissions, deviceId);

    const id = newId('grt');
    try {
      tx(db, () => {
        db.prepare('INSERT INTO grants (id, org_id, user_id, device_id, effect, starts_at, expires_at, created_by) VALUES (?,?,?,?,?,?,?,?)')
          .run(id, p.org, userId, deviceId, effect, startsAt, expiresAt, ctx.userId);
        // The FK to permission_patterns is the validation: 'device:teleport' or 'Device:View'
        // fails here, and the whole grant rolls back.
        const add = db.prepare('INSERT OR IGNORE INTO grant_permissions (grant_id, permission) VALUES (?,?)');
        for (const perm of permissions) add.run(id, perm);
        bumpPermVersion(db, { orgId: p.org, userId });
        audit(db, { orgId: p.org, actorId: ctx.userId, action: 'grant.create', targetType: 'grant', targetId: id, requestId: ctx.requestId });
      });
    } catch (err) {
      if (err?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') throw badRequest('unknown permission', 'unknown_permission');
      throw err;
    }
    const grant = db.prepare('SELECT id, user_id, device_id, effect, starts_at, expires_at, created_by, created_at FROM grants WHERE id = ?').get(id);
    send(res, 201, { ...grant, permissions: grantPermissions(db, [id])[id] });
  }, (p) => ({ targetType: 'grant' }));

  on('delete', '/v1/orgs/:org/grants/:id', 'grant.revoke', (ctx, p, res) => {
    const grant = db.prepare('SELECT id, user_id, device_id FROM grants WHERE id = ? AND org_id = ? AND revoked_at IS NULL').get(p.id, p.org);
    if (!grant) throw notFound();
    assertCan(db, ctx, 'grant:revoke', grant.device_id);
    tx(db, () => {
      db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ?').run(nowIso(), grant.id);
      bumpPermVersion(db, { orgId: p.org, userId: grant.user_id });
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'grant.revoke', targetType: 'grant', targetId: grant.id, requestId: ctx.requestId });
    });
    send(res, 204);
  }, (p) => ({ targetType: 'grant', targetId: p.id }));
}
