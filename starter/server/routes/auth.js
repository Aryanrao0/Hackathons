// Sign-in, refresh, sign-out, org switch, and "who am I".
//
// Access token: a JWT for exactly one org, returned in the body, kept in memory by the client.
// Refresh token: opaque, stored only as a hash, sent as an httpOnly cookie on /v1/auth only.
// Rotation: every refresh revokes the presented token and issues its successor in the same
// family; presenting an already-revoked token revokes the whole family (replay detection).

import {
  issueAccessToken, verifyPassword, hashPassword,
  newRefreshToken, hashRefreshToken, REFRESH_TTL_SECONDS,
} from '../auth.js';
import { send, badRequest, unauthenticated, notFound, forbidden } from '../http.js';
import { newId, nowIso } from '../db.js';
import { resolve } from '../permissions.js';

const COOKIE = 'rt';
// Verifying against a throwaway hash when the email is unknown keeps the two failures
// taking the same time, so response time does not reveal which accounts exist.
const DUMMY_HASH = hashPassword('not-a-real-password');

export function listOrgs(db, userId) {
  return db.prepare(
    `SELECT o.id, o.name, o.theme, m.role, m.status
       FROM memberships m JOIN organizations o ON o.id = m.org_id AND o.deleted_at IS NULL
      WHERE m.user_id = ? AND m.status IN ('active','suspended')
      ORDER BY o.name, o.id`
  ).all(userId);
}

// The body every sign-in style endpoint returns. orgId picks the org; without one, the
// alphabetically first org where the membership is active.
export function sessionBody(db, secret, userId, orgId = null) {
  const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(userId);
  const orgs = listOrgs(db, userId);
  let chosen;
  if (orgId) {
    chosen = orgs.find((o) => o.id === orgId);
    if (!chosen) throw notFound();
    if (chosen.status !== 'active') throw forbidden('your membership in that org is suspended', 'suspended');
  } else {
    chosen = orgs.find((o) => o.status === 'active');
  }
  if (!chosen) return { token: null, orgId: null, role: null, orgs, user };

  const { perm_version: permVersion } = db.prepare(
    'SELECT perm_version FROM memberships WHERE org_id = ? AND user_id = ?'
  ).get(chosen.id, userId);
  const token = issueAccessToken({ userId, orgId: chosen.id, role: chosen.role, permVersion }, secret);
  return { token, orgId: chosen.id, role: chosen.role, orgs, user };
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function setRefreshCookie(res, raw, maxAge = REFRESH_TTL_SECONDS) {
  res.setHeader('set-cookie', `${COOKIE}=${raw}; HttpOnly; Secure; SameSite=Strict; Path=/v1/auth; Max-Age=${maxAge}`);
}

// Stores the hash and returns the raw token. The caller sets the cookie only AFTER its
// transaction commits — a cookie for a rolled-back row would be a dead credential.
export function newRefreshRow(db, userId, familyId = newId('fam')) {
  const raw = newRefreshToken();
  db.prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at) VALUES (?,?,?,?,?)')
    .run(newId('rtk'), userId, hashRefreshToken(raw), familyId, new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString());
  return raw;
}

const revokeFamily = (db, familyId) =>
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(nowIso(), familyId);

export function authRoutes(on, { db, secret }) {
  on('post', '/v1/auth/login', 'auth.login', (ctx, _p, res) => {
    const { email, password, orgId } = ctx.body;
    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
      throw badRequest('email and password are required');
    }
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email.trim().toLowerCase());
    const ok = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw unauthenticated('invalid email or password');

    const body = sessionBody(db, secret, user.id, orgId ?? null);
    setRefreshCookie(res, newRefreshRow(db, user.id));
    send(res, 200, body);
  });

  on('post', '/v1/auth/refresh', 'auth.refresh', (ctx, _p, res) => {
    const raw = readCookie(ctx.req, COOKIE);
    if (!raw) throw unauthenticated('no refresh token');
    const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hashRefreshToken(raw));
    if (!row) throw unauthenticated('invalid refresh token');

    if (row.revoked_at) {
      revokeFamily(db, row.family_id);   // replay of a rotated token: kill the lineage
      throw unauthenticated('refresh token reuse detected');
    }
    if (row.expires_at <= nowIso()) throw unauthenticated('refresh token expired');

    const rotated = db.transaction(() => {
      // The WHERE revoked_at IS NULL makes two concurrent refreshes race safely: only one
      // UPDATE changes a row, the other is treated as the replay it is. It returns rather
      // than throws, because a throw here would roll back the family revocation below.
      const { changes } = db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), row.id);
      if (changes !== 1) return null;
      const next = newRefreshRow(db, row.user_id, row.family_id);
      return { body: sessionBody(db, secret, row.user_id, ctx.body.orgId ?? null), next };
    })();
    if (!rotated) {
      revokeFamily(db, row.family_id);
      throw unauthenticated('refresh token reuse detected');
    }
    const { body, next } = rotated;
    setRefreshCookie(res, next);
    send(res, 200, body);
  });

  on('post', '/v1/auth/logout', 'auth.logout', (ctx, _p, res) => {
    const raw = readCookie(ctx.req, COOKIE);
    const row = raw && db.prepare('SELECT family_id FROM refresh_tokens WHERE token_hash = ?').get(hashRefreshToken(raw));
    if (row) revokeFamily(db, row.family_id);
    setRefreshCookie(res, '', 0);
    send(res, 204);
  });

  on('post', '/v1/auth/token', 'auth.switch_org', (ctx, _p, res) => {
    const { orgId } = ctx.body;
    if (typeof orgId !== 'string' || !orgId) throw badRequest('orgId is required');
    send(res, 200, sessionBody(db, secret, ctx.userId, orgId));
  });

  on('get', '/v1/auth/me', 'auth.me', (ctx, _p, res) => {
    const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(ctx.userId);
    const org = db.prepare('SELECT id, name, theme, max_session_minutes FROM organizations WHERE id = ?').get(ctx.orgId);
    const { permissions } = resolve(db, { userId: ctx.userId, orgId: ctx.orgId });
    send(res, 200, {
      user,
      orgId: ctx.orgId,
      org: { id: org.id, name: org.name, theme: org.theme, maxSessionMinutes: org.max_session_minutes },
      role: ctx.role,
      orgs: listOrgs(db, ctx.userId),
      permissions,
    });
  });
}
