// Sessions: records, not remote access. Nothing streams, nothing is injected.
//
// Start = the compound check (session:start AND the mode permission, one device, one
// resolution) -> insert. Exclusivity is not checked first: the insert is attempted and the
// partial unique index `one_exclusive_session_per_device` refuses the loser of any race.
//
// A session's authority is the snapshot in authorized_by. Permission changes never end one;
// its expires_at does (swept lazily by expireSessions before every read or start).

import { send, badRequest, notFound, forbidden, conflict, deviceBusy } from '../http.js';
import { newId, nowIso } from '../db.js';
import { can, assertCanStartSession } from '../permissions.js';
import { snapshotAuthority, sessionExpiry, expireSessions } from '../lifecycle.js';
import { audit } from '../audit.js';

const COLUMNS = 'id, org_id, user_id, device_id, mode, state, end_reason, authorized_by, started_at, expires_at, ended_at';

const toSession = (s) => ({ ...s, authorized_by: JSON.parse(s.authorized_by) });

// Sessions are addressed by id alone (/v1/sessions/:id), so the org scoping happens here:
// a session in another org is simply not found.
function findSession(db, orgId, id) {
  expireSessions(db, orgId);
  const s = db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ? AND org_id = ?`).get(id, orgId);
  if (!s) throw notFound();
  return s;
}

export function sessionRoutes(on, { db }) {
  const session = (p) => ({ targetType: 'session', targetId: p.id });

  on('post', '/v1/orgs/:org/sessions', 'session.start', (ctx, p, res) => {
    const { deviceId, mode } = ctx.body;
    if (typeof deviceId !== 'string') throw badRequest('deviceId is required');
    if (!['view', 'control', 'terminal'].includes(mode)) throw badRequest('mode must be view, control or terminal');
    const device = db.prepare('SELECT id FROM devices WHERE id = ? AND org_id = ? AND deleted_at IS NULL').get(deviceId, p.org);
    if (!device) throw notFound();

    assertCanStartSession(db, ctx, mode, deviceId);
    expireSessions(db, p.org);

    const id = newId('ses');
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO sessions (id, org_id, user_id, device_id, mode, state, authorized_by, started_at, expires_at)
           VALUES (?,?,?,?,?,'active',?,?,?)`
        ).run(id, p.org, ctx.userId, deviceId, mode,
          JSON.stringify(snapshotAuthority(db, { userId: ctx.userId, orgId: p.org, deviceId })),
          nowIso(), sessionExpiry(db, p.org));
        audit(db, { orgId: p.org, actorId: ctx.userId, action: 'session.start', targetType: 'device', targetId: deviceId, requestId: ctx.requestId });
      })();
    } catch (err) {
      if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const holder = db.prepare(
          "SELECT id FROM sessions WHERE device_id = ? AND state = 'active' AND mode IN ('control','terminal')"
        ).get(deviceId);
        throw deviceBusy(`device already has an exclusive session${holder ? ` (${holder.id})` : ''}`);
      }
      throw err;
    }
    send(res, 201, toSession(db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`).get(id)));
  }, (p) => ({ targetType: 'device' }));

  on('get', '/v1/orgs/:org/sessions', 'session.list', (ctx, p, res) => {
    if (!can(db, ctx, 'session:view')) throw forbidden('session:view is required');
    expireSessions(db, p.org);
    const sessions = db.prepare(
      `SELECT ${COLUMNS} FROM sessions WHERE org_id = ? ORDER BY started_at DESC, id LIMIT 200`
    ).all(p.org);
    send(res, 200, { sessions: sessions.map(toSession) });
  });

  on('get', '/v1/sessions/:id', 'session.view', (ctx, p, res) => {
    const s = findSession(db, ctx.orgId, p.id);
    if (s.user_id !== ctx.userId && !can(db, ctx, 'session:view')) throw forbidden('session:view is required');
    send(res, 200, toSession(s));
  }, session);

  on('delete', '/v1/sessions/:id', 'session.end', (ctx, p, res) => {
    const s = findSession(db, ctx.orgId, p.id);
    const own = s.user_id === ctx.userId;
    if (!own && !can(db, ctx, 'session:terminate')) throw forbidden('session:terminate is required to end someone else\'s session');
    if (s.state === 'ended') throw conflict('session has already ended');

    db.transaction(() => {
      db.prepare("UPDATE sessions SET state = 'ended', end_reason = ?, ended_at = ? WHERE id = ?")
        .run(own ? 'user_stopped' : 'admin_terminated', nowIso(), s.id);
      audit(db, { orgId: ctx.orgId, actorId: ctx.userId, action: own ? 'session.stop' : 'session.terminate', targetType: 'session', targetId: s.id, requestId: ctx.requestId });
    })();
    send(res, 200, toSession(db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`).get(s.id)));
  }, session);
}
