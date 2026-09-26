// Append-only audit writes.
//
// audit_events has BEFORE UPDATE / BEFORE DELETE triggers, so this module only ever INSERTs.
//
//   - a SUCCESS row is written by the route, inside the same transaction as the change, so
//     a rolled-back change leaves no row claiming it happened.
//   - a REFUSAL row is written by auditDenials(), which wraps every authenticated handler in
//     routes/index.js. What counts as a refusal: 403 (permission, rank, self-change) and the
//     409s that are the system saying no to an attempt (LAST_OWNER, DEVICE_BUSY).
//     404s are not audited: they are what a caller sees for things outside their org.

import { HttpError } from './http.js';
import { newId, nowIso } from './db.js';

export function audit(db, { orgId, actorId, action, targetType = null, targetId = null, result = 'allow', reasonCode = null, requestId = null }) {
  db.prepare(
    `INSERT INTO audit_events (id, org_id, actor_id, action, target_type, target_id, result, reason_code, request_id, at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(newId('aud'), orgId, actorId, action, targetType, targetId, result, reasonCode, requestId, nowIso());
}

const AUDITED_REFUSALS = new Set(['FORBIDDEN', 'SELF_ROLE_CHANGE', 'LAST_OWNER', 'DEVICE_BUSY']);

// Run fn(); if it refuses, record the denial before rethrowing.
export async function auditDenials(db, ctx, meta, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError && AUDITED_REFUSALS.has(err.code) && ctx.orgId) {
      audit(db, {
        orgId: ctx.orgId,
        actorId: ctx.userId,
        action: meta.action,
        targetType: meta.targetType ?? null,
        targetId: meta.targetId ?? null,
        result: 'deny',
        reasonCode: err.reason ?? err.code.toLowerCase(),
        requestId: ctx.requestId,
      });
    }
    throw err;
  }
}
