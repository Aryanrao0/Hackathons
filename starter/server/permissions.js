// The permission resolution engine. THE ONLY PLACE allow-vs-deny is decided.
//
// Nothing about roles or permissions is written down in this file. The catalogue comes from
// `permissions`, the bundles from `role_permissions`, the deltas from `grants`. A database
// with a role or permission no document mentions resolves exactly like the documented ones.
//
// Shape: loadInputs() does all the reading (4 queries), evaluate() is a pure function over
// what was read. Every public function below is built from those two, so there is one
// implementation of the rules and a list endpoint never pays per row.

import { forbidden, badRequest } from './http.js';

export const MODE_PERMISSION = { view: 'device:view', control: 'device:control', terminal: 'device:terminal' };

const IMPLICIT = Object.freeze({ effect: 'deny', source: null, reason: 'implicit' });

// --- reading ------------------------------------------------------------------

function loadCatalogue(db) {
  return db.prepare('SELECT key, resource FROM permissions ORDER BY key').all();
}

// A pattern names concrete permissions: '*' is all of them, 'device:*' is every permission
// whose RESOURCE is 'device' (read from the table, so 'device:reboot' is included when it
// exists), anything else is itself if it is in the catalogue.
export function expandPattern(pattern, catalogue) {
  if (pattern === '*') return catalogue.map((p) => p.key);
  if (pattern.endsWith(':*')) {
    const resource = pattern.slice(0, -2);
    return catalogue.filter((p) => p.resource === resource).map((p) => p.key);
  }
  return catalogue.some((p) => p.key === pattern) ? [pattern] : [];
}

function loadInputs(db, { userId, orgId, now }) {
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const catalogue = loadCatalogue(db);

  // A soft-deleted org has no members as far as authority is concerned.
  const membership = db.prepare(
    `SELECT m.role, m.status FROM memberships m
       JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
      WHERE m.org_id = ? AND m.user_id = ?`
  ).get(orgId, userId) ?? null;

  if (!membership || membership.status !== 'active') {
    return { catalogue, membership, baseline: new Set(), grants: [] };
  }

  const baseline = new Set(
    db.prepare('SELECT permission FROM role_permissions WHERE role = ?').all(membership.role).map((r) => r.permission)
  );

  // Every grant that is live right now, at every scope, in THIS org only. Half-open window:
  // starts_at <= now < expires_at. A device-scoped grant only counts while its device is
  // still in this org and not deleted — a transferred device must not carry authority back.
  const rows = db.prepare(
    `SELECT g.id, g.effect, g.device_id, gp.permission
       FROM grants g
       JOIN grant_permissions gp ON gp.grant_id = g.id
       LEFT JOIN devices d ON d.id = g.device_id
      WHERE g.org_id = ? AND g.user_id = ? AND g.revoked_at IS NULL
        AND (g.starts_at IS NULL OR g.starts_at <= ?)
        AND (g.expires_at IS NULL OR g.expires_at > ?)
        AND (g.device_id IS NULL OR (d.org_id = g.org_id AND d.deleted_at IS NULL))
      ORDER BY g.created_at, g.id`
  ).all(orgId, userId, at, at);

  const grants = rows.map((r) => ({
    id: r.id,
    effect: r.effect,
    deviceId: r.device_id,
    covers: new Set(expandPattern(r.permission, catalogue)),
  }));

  return { catalogue, membership, baseline, grants };
}

// --- deciding -----------------------------------------------------------------

function refusedWholesale({ catalogue, membership }) {
  const reason = membership?.status === 'suspended' ? 'suspended' : 'not_a_member';
  const answer = Object.freeze({ effect: 'deny', source: null, reason });
  return Object.fromEntries(catalogue.map((p) => [p.key, answer]));
}

// One permission against one set of applicable grants. The order IS the rule:
// deny first (D1), then role baseline, then allow grants, then implicit deny (D4).
function decide(permission, role, baseline, applicable) {
  const deny = applicable.find((g) => g.effect === 'deny' && g.covers.has(permission));
  if (deny) return { effect: 'deny', source: `grant:${deny.id}`, reason: 'explicit_deny' };
  if (baseline.has(permission)) return { effect: 'allow', source: `role:${role}`, reason: null };
  const allow = applicable.find((g) => g.effect === 'allow' && g.covers.has(permission));
  if (allow) return { effect: 'allow', source: `grant:${allow.id}`, reason: null };
  return IMPLICIT;
}

// deviceId = a device id -> org-wide grants + that device's grants (the exact check).
// deviceId = null        -> org-wide grants ONLY. Used for org-scoped actions and for
//                           "may you grant this org-wide" (no laundering via one device).
function evaluate(inputs, deviceId) {
  const { catalogue, membership, baseline, grants } = inputs;
  if (!membership || membership.status !== 'active') return refusedWholesale(inputs);

  const applicable = grants.filter((g) => g.deviceId === null || g.deviceId === deviceId);
  return Object.fromEntries(catalogue.map((p) => [p.key, decide(p.key, membership.role, baseline, applicable)]));
}

// The org-level VIEW (navigation, /auth/me): "is this allowed anywhere in the org?".
// Start from the org-wide answer; a permission it denies only implicitly becomes allowed
// if some device-scoped allow grant is effective on its own device. An org-wide deny is
// never lifted, and a device-scoped deny never spreads to the org level.
function evaluateOrgView(inputs) {
  const orgWide = evaluate(inputs, null);
  const { grants } = inputs;
  const scopedDevices = [...new Set(grants.filter((g) => g.deviceId !== null).map((g) => g.deviceId))];
  if (!scopedDevices.length) return orgWide;

  const perDevice = scopedDevices.map((id) => evaluate(inputs, id));
  for (const key of Object.keys(orgWide)) {
    if (orgWide[key].reason !== 'implicit') continue;
    const lifted = perDevice.find((set) => set[key].effect === 'allow');
    if (lifted) orgWide[key] = lifted[key];
  }
  return orgWide;
}

// --- public API ---------------------------------------------------------------

// Resolve one user's permission set in one org. deviceId === null means the org-level
// view; a deviceId means the exact per-device check.
export function resolve(db, { userId, orgId, deviceId = null, now = new Date() }) {
  const inputs = loadInputs(db, { userId, orgId, now });
  const permissions = deviceId === null ? evaluateOrgView(inputs) : evaluate(inputs, deviceId);
  return { role: inputs.membership?.role ?? null, permissions };
}

// Batched form for list endpoints: { role, byDevice: { [deviceId]: permissions } }.
// Same four queries whatever the number of devices.
export function resolveDevices(db, { userId, orgId, deviceIds, now = new Date() }) {
  const inputs = loadInputs(db, { userId, orgId, now });
  const byDevice = {};
  for (const id of deviceIds) byDevice[id] = evaluate(inputs, id);
  return { role: inputs.membership?.role ?? null, byDevice };
}

// A gate without a device uses the same org-level view the console's navigation is drawn
// from, so an entry that is on screen is never refused by its own endpoint. (The strict
// org-wide scope is only for assertMayGrant, below.)
function decision(db, ctx, permission, deviceId) {
  const { permissions } = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId: deviceId ?? null });
  return permissions[permission] ?? IMPLICIT;
}

export function can(db, ctx, permission, deviceId = null) {
  return decision(db, ctx, permission, deviceId).effect === 'allow';
}

// Throws 403 carrying the reason code, so a refusal is debuggable.
export function assertCan(db, ctx, permission, deviceId = null) {
  const d = decision(db, ctx, permission, deviceId);
  if (d.effect === 'allow') return d;
  const reason = d.reason === 'implicit' ? 'missing_permission' : d.reason;
  throw forbidden(`${permission} is required`, reason);
}

// No privilege laundering: you may only grant authority you hold at that scope. A device
// grant is checked against the device; an org-wide grant against the org-wide set, so a
// one-device allow cannot be turned into an org-wide one. Wildcards are expanded first, so
// granting 'device:*' means holding every device permission — including undocumented ones.
export function assertMayGrant(db, ctx, patterns, deviceId = null) {
  const inputs = loadInputs(db, { userId: ctx.userId, orgId: ctx.orgId, now: new Date() });
  const held = evaluate(inputs, deviceId);
  for (const pattern of patterns) {
    for (const key of expandPattern(pattern, inputs.catalogue)) {
      if (held[key]?.effect !== 'allow') {
        throw forbidden(`you cannot grant ${key}: you do not hold it at this scope`, 'scope_mismatch');
      }
    }
  }
}

// The compound check: session:start AND the permission for the requested mode, on the same
// device, from ONE resolution. The two refusals carry different reasons so the caller can
// tell "you cannot open sessions" from "not on this device".
export function assertCanStartSession(db, ctx, mode, deviceId) {
  const modePermission = MODE_PERMISSION[mode];
  if (!modePermission) throw badRequest('mode must be view, control or terminal');

  const { permissions } = resolve(db, { userId: ctx.userId, orgId: ctx.orgId, deviceId });
  const start = permissions['session:start'];
  if (start.effect !== 'allow') {
    throw forbidden(`session:start is ${start.reason === 'explicit_deny' ? 'explicitly denied' : 'not granted'}`, 'missing_permission');
  }
  const device = permissions[modePermission];
  if (device.effect !== 'allow') {
    throw forbidden(`${modePermission} is ${device.reason === 'explicit_deny' ? 'explicitly denied' : 'not granted'} on this device`, 'missing_device_permission');
  }
  return permissions;
}
