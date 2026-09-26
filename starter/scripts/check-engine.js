// Our own engine checks — the decisions the shipped suites do not pin down.
// Run: node scripts/check-engine.js   (same harness shape as check-permissions.js)

import { readFileSync } from 'node:fs';
import { openDatabase, newId } from '../server/db.js';
import { resolve, assertMayGrant, assertCan } from '../server/permissions.js';
import { buildOverlay, applyOverlay } from './personalise.js';

const db = openDatabase(':memory:');
db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
db.exec(readFileSync(new URL('../db/reference.sql', import.meta.url), 'utf8'));
const seed = JSON.parse(readFileSync(new URL('../seed/orgs.json', import.meta.url), 'utf8'));
for (const o of seed.organizations) db.prepare('INSERT INTO organizations (id,name,theme) VALUES (?,?,?)').run(o.id, o.name, o.theme);
for (const u of seed.users) db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(u.id, u.email, u.name, 'x');
for (const m of seed.memberships) db.prepare('INSERT INTO memberships (id,org_id,user_id,role,status) VALUES (?,?,?,?,?)').run(newId('mem'), m.orgId, m.userId, m.role, m.status);
for (const d of seed.devices) db.prepare('INSERT INTO devices (id,org_id,name,kind) VALUES (?,?,?,?)').run(d.id, d.orgId, d.name, d.kind);
const grant = (id, orgId, userId, deviceId, effect, perms, extra = {}) => {
  db.prepare('INSERT INTO grants (id,org_id,user_id,device_id,effect,starts_at,expires_at,created_by) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, orgId, userId, deviceId, effect, extra.startsAt ?? null, extra.expiresAt ?? null, 'usr_acme_owner');
  for (const p of perms) db.prepare('INSERT INTO grant_permissions (grant_id,permission) VALUES (?,?)').run(id, p);
};
for (const g of seed.grants) grant(g.id, g.orgId, g.userId, g.deviceId ?? null, g.effect, g.permissions);

// A personalised org whose extra permission is a DEVICE permission, so device:* must cover it.
const overlay = buildOverlay('grade/a/1');   // draws device:unlock
applyOverlay(db, overlay, { passwordHash: () => 'x' });

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label.padEnd(64)}${ok ? '' : ` got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
};
const refusal = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.reason ?? e.message; } };
const A = 'org_acme';
const perm = (userId, orgId, key, deviceId = null) => resolve(db, { userId, orgId, deviceId }).permissions[key];

console.log('\n== org-level view is a union over devices ==');
check('viewer: session:start org-level (device grant lifts it)', perm('usr_acme_viewer', A, 'session:start').effect, 'allow');
check('  ...source is the device grant', perm('usr_acme_viewer', A, 'session:start').source, 'grant:grt_viewer_start_session');
check('viewer: device:view org-level survives a one-device deny', perm('usr_acme_viewer', A, 'device:view').effect, 'allow');
check('sam: device:terminal org-level is an explicit deny', perm('usr_sam', A, 'device:terminal').reason, 'explicit_deny');

console.log('\n== wildcards expand from the table, not from the docs ==');
const { orgId: P, devices } = { orgId: overlay.org.id, devices: overlay.devices };
grant('g_wild_p', P, overlay.bystander.id, devices[0].id, 'allow', ['device:*']);
check(`device:* covers the undocumented ${overlay.permission.key}`, perm(overlay.bystander.id, P, overlay.permission.key, devices[0].id).effect, 'allow');
check('  ...on that device only', perm(overlay.bystander.id, P, overlay.permission.key, devices[1].id).effect, 'deny');

console.log('\n== no laundering: scope of what you hold ==');
const viewerCtx = { userId: 'usr_acme_viewer', orgId: A };
check('may re-grant session:start on the device it is held on', refusal(() => assertMayGrant(db, viewerCtx, ['session:start'], 'dev_lab_mac_01')), 'ok');
check('may NOT grant it org-wide from a one-device grant', refusal(() => assertMayGrant(db, viewerCtx, ['session:start'], null)), 'scope_mismatch');
check('admin may not grant * (lacks org:delete)', refusal(() => assertMayGrant(db, { userId: 'usr_acme_admin', orgId: A }, ['*'])), 'scope_mismatch');
check('sam may not grant device:* (terminal denied org-wide)', refusal(() => assertMayGrant(db, { userId: 'usr_sam', orgId: A }, ['device:*'], 'dev_lab_win_01')), 'scope_mismatch');

console.log('\n== half-open window, exactly at the boundary ==');
const edge = new Date(Date.now() + 60_000);
grant('g_edge', A, 'usr_acme_viewer', 'dev_lab_win_01', 'allow', ['device:control'], { expiresAt: edge.toISOString() });
check('1ms before expires_at: active', resolve(db, { userId: 'usr_acme_viewer', orgId: A, deviceId: 'dev_lab_win_01', now: new Date(edge - 1) }).permissions['device:control'].effect, 'allow');
check('expires_at == now: expired', resolve(db, { userId: 'usr_acme_viewer', orgId: A, deviceId: 'dev_lab_win_01', now: edge }).permissions['device:control'].effect, 'deny');

console.log('\n== a transferred device takes no authority with it ==');
db.prepare("UPDATE devices SET org_id = 'org_globex' WHERE id = 'dev_lab_mac_01'").run();
check('viewer: session:start org-level falls back to implicit', perm('usr_acme_viewer', A, 'session:start').reason, 'implicit');
db.prepare("UPDATE devices SET org_id = 'org_acme' WHERE id = 'dev_lab_mac_01'").run();

console.log('\n== assertCan reports why ==');
check('implicit -> missing_permission', refusal(() => assertCan(db, viewerCtx, 'audit:read')), 'missing_permission');
check('org-wide deny -> explicit_deny', refusal(() => assertCan(db, { userId: 'usr_sam', orgId: A }, 'device:terminal', 'dev_lab_win_01')), 'explicit_deny');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
