// Invites: the only way a person joins an org.
//
// The raw token is a bearer credential: returned once from POST, stored only as a hash,
// never logged, never echoed. The public GET shows just enough to render "you've been
// invited to X as Y" — no ids, no members, no devices.
//
// Races are the database's job: `one_live_invite_per_email` refuses a second live invite,
// and accept flips the invite with `WHERE accepted_at IS NULL AND revoked_at IS NULL`, so
// of two concurrent accepts exactly one changes a row.

import { send, badRequest, notFound, conflict, gone } from '../http.js';
import { newId, nowIso, bumpPermVersion } from '../db.js';
import { newInviteToken, hashInviteToken, hashPassword } from '../auth.js';
import { assertCan } from '../permissions.js';
import { assertRoleExists, assertCanAssign } from '../lifecycle.js';
import { audit } from '../audit.js';
import { requireName } from './orgs.js';
import { sessionBody } from './auth.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isUniqueViolation = (err) => err?.code === 'SQLITE_CONSTRAINT_UNIQUE';

function normaliseEmail(value) {
  if (typeof value !== 'string') throw badRequest('email is required');
  const email = value.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw badRequest('email is not valid');
  return email;
}

// Look an invite up by its raw token and classify it. Expired or cancelled -> 410,
// already used -> 409, never existed -> 404.
function liveInvite(db, rawToken) {
  const invite = db.prepare(
    `SELECT i.*, o.name AS org_name, o.deleted_at AS org_deleted
       FROM invites i JOIN organizations o ON o.id = i.org_id
      WHERE i.token_hash = ?`
  ).get(hashInviteToken(rawToken));
  if (!invite) throw notFound();
  if (invite.accepted_at) throw conflict('this invite has already been used');
  if (invite.revoked_at || invite.org_deleted || invite.expires_at <= nowIso()) throw gone();
  return invite;
}

export function inviteRoutes(on, { db, secret }) {
  on('post', '/v1/orgs/:org/invites', 'invite.create', (ctx, p, res) => {
    assertCan(db, ctx, 'user:invite');
    const email = normaliseEmail(ctx.body.email);
    const { role } = ctx.body;
    assertRoleExists(db, role);
    assertCanAssign(db, ctx.role, role);

    const already = db.prepare(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = ? AND u.email = ? AND m.status IN ('active','suspended')`
    ).get(p.org, email);
    if (already) throw conflict('that person is already a member of this org');

    const rawToken = newInviteToken();
    const id = newId('inv');
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    try {
      db.transaction(() => {
        db.prepare('INSERT INTO invites (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, p.org, email, role, hashInviteToken(rawToken), ctx.userId, expiresAt);
        audit(db, { orgId: p.org, actorId: ctx.userId, action: 'invite.create', targetType: 'invite', targetId: id, requestId: ctx.requestId });
      })();
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('there is already a live invite for that email');
      throw err;
    }
    send(res, 201, { id, email, role, expiresAt, inviteToken: rawToken });
  });

  on('get', '/v1/orgs/:org/invites', 'invite.list', (ctx, p, res) => {
    assertCan(db, ctx, 'user:invite');
    const invites = db.prepare(
      `SELECT id, email, role, invited_by, expires_at, created_at FROM invites
        WHERE org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC`
    ).all(p.org, nowIso());
    send(res, 200, { invites });
  });

  on('delete', '/v1/orgs/:org/invites/:id', 'invite.revoke', (ctx, p, res) => {
    assertCan(db, ctx, 'user:invite');
    db.transaction(() => {
      const { changes } = db.prepare(
        'UPDATE invites SET revoked_at = ? WHERE id = ? AND org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL'
      ).run(nowIso(), p.id, p.org);
      if (changes !== 1) throw notFound();
      audit(db, { orgId: p.org, actorId: ctx.userId, action: 'invite.revoke', targetType: 'invite', targetId: p.id, requestId: ctx.requestId });
    })();
    send(res, 204);
  }, (p) => ({ targetType: 'invite', targetId: p.id }));

  // --- public -------------------------------------------------------------------

  on('get', '/v1/invites/:token', 'invite.peek', (ctx, p, res) => {
    const invite = liveInvite(db, p.token);
    send(res, 200, { orgName: invite.org_name, role: invite.role, email: invite.email, expiresAt: invite.expires_at });
  });

  on('post', '/v1/invites/:token/accept', 'invite.accept', (ctx, p, res) => {
    const body = db.transaction(() => {
      const invite = liveInvite(db, p.token);

      // An existing platform user is attached, never duplicated, and keeps their password.
      let user = db.prepare('SELECT id FROM users WHERE email = ?').get(invite.email);
      if (!user) {
        const name = requireName(ctx.body.name);
        const { password } = ctx.body;
        if (typeof password !== 'string' || password.length < 8) throw badRequest('password must be at least 8 characters');
        user = { id: newId('usr') };
        db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)')
          .run(user.id, invite.email, name, hashPassword(password));
      }

      const { changes } = db.prepare(
        'UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL'
      ).run(nowIso(), user.id, invite.id);
      if (changes !== 1) throw conflict('this invite has already been used');

      const existing = db.prepare('SELECT status FROM memberships WHERE org_id = ? AND user_id = ?').get(invite.org_id, user.id);
      if (existing && existing.status !== 'removed') throw conflict('already a member of this org');
      if (existing) {
        // Rehire: the old row comes back with the invited role and a new version, so any
        // token from the previous membership is stale. Old grants were revoked at removal.
        db.prepare("UPDATE memberships SET role = ?, status = 'active', invited_by = ?, joined_at = ? WHERE org_id = ? AND user_id = ?")
          .run(invite.role, invite.invited_by, nowIso(), invite.org_id, user.id);
        bumpPermVersion(db, { orgId: invite.org_id, userId: user.id });
      } else {
        db.prepare("INSERT INTO memberships (id, org_id, user_id, role, status, invited_by, joined_at) VALUES (?,?,?,?,'active',?,?)")
          .run(newId('mem'), invite.org_id, user.id, invite.role, invite.invited_by, nowIso());
      }
      audit(db, { orgId: invite.org_id, actorId: user.id, action: 'invite.accept', targetType: 'invite', targetId: invite.id, requestId: ctx.requestId });
      return sessionBody(db, secret, user.id, invite.org_id);
    })();
    send(res, 200, body);
  });
}
