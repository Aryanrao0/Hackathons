// Our own HTTP edge cases: the awkward seams the shipped check-api.js does not reach.
// Spawns the server against a throwaway database, like check-api.js.
//
//   node scripts/check-edges.js

import { spawn, execFileSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import Database from 'better-sqlite3';

const PORT = 8125;
const BASE = `http://localhost:${PORT}/v1`;
const DB = 'check-edges.db';

for (const s of ['', '-wal', '-shm']) if (existsSync(DB + s)) rmSync(DB + s);
execFileSync(process.execPath, ['scripts/load-db.js'], { env: { ...process.env, DATABASE_FILE: DB }, stdio: 'ignore' });
const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, DATABASE_FILE: DB, PORT: String(PORT), NODE_ENV: 'production', JWT_SECRET: 'edge-secret' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
await new Promise((r) => setTimeout(r, 1200));
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (err) => { console.error(`\n  aborted: ${err?.stack ?? err}`); server.kill(); process.exit(1); });
}

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label.padEnd(64)}${ok ? '' : ` got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
};

async function call(method, path, { token, body, cookie, rawAuth } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (rawAuth !== undefined) headers.authorization = rawAuth;
  if (body) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json, setCookie: res.headers.get('set-cookie') };
}
const login = async (email, password = 'demo1234') => {
  const r = await call('POST', '/auth/login', { body: { email, password } });
  return { ...r.body, cookie: r.setCookie?.split(';')[0] };
};
const code = (r) => `${r.status} ${r.body?.error?.code ?? ''}`.trim();

const dana = await login('dana@example.test');           // owner, Acme
const admin = await login('admin@acme.test');
const viewer = await login('viewer@acme.test');

// ---------------------------------------------------------------------------
console.log('\n== malformed credentials are 401, never 500 ==');
for (const [label, rawAuth] of [
  ['no scheme', 'eyJhbGciOi'],
  ['Bearer with nothing', 'Bearer '],
  ['Bearer garbage', 'Bearer x.y.z'],
  ['Basic auth', 'Basic ZGFuYTpkZW1vMTIzNA=='],
  ['two tokens', `Bearer ${dana.token} ${dana.token}`],
]) check(label, code(await call('GET', '/auth/me', { rawAuth })), '401 UNAUTHENTICATED');
// Over Node's 16 KB header limit the HTTP parser answers 431 before our code runs.
check('20 KB token: refused by node:http, not a 500', (await call('GET', '/auth/me', { rawAuth: `Bearer ${'a'.repeat(20000)}.b.c` })).status, 431);

console.log('\n== cross-org ids are invisible, whatever the route ==');
const globexSession = await call('GET', '/sessions/ses_live_build_server', { token: (await call('POST', '/auth/token', { token: dana.token, body: { orgId: 'org_globex' } })).body.token });
check('Acme session read with a Globex token -> 404', globexSession.status, 404);
check('switch to an org you are not in -> 404', (await call('POST', '/auth/token', { token: viewer.token, body: { orgId: 'org_globex' } })).status, 404);
check('grant on a Globex device from Acme -> 404', (await call('POST', '/orgs/org_acme/grants', { token: dana.token, body: { userId: 'usr_acme_viewer', deviceId: 'dev_globex_desk_01', effect: 'allow', permissions: ['device:control'] } })).status, 404);

console.log('\n== grant validation ==');
const g = (body) => call('POST', '/orgs/org_acme/grants', { token: dana.token, body: { userId: 'usr_acme_viewer', effect: 'allow', permissions: ['device:control'], ...body } });
check('expiresAt in the past -> 400 GRANT_EXPIRED', code(await g({ expiresAt: new Date(Date.now() - 1000).toISOString() })), '400 GRANT_EXPIRED');
check('expiresAt not a timestamp -> 400', code(await g({ expiresAt: 'tomorrow-ish' })), '400 VALIDATION');
check('wrong case Device:Control -> 400', (await g({ permissions: ['Device:Control'] })).body.error.reason, 'unknown_permission');
check('effect "maybe" -> 400', code(await g({ effect: 'maybe' })), '400 VALIDATION');
check('grant to a user in no org here -> 404', (await g({ userId: 'usr_globex_owner' })).status, 404);

console.log('\n== no laundering across scope ==');
const denyAdmin = await call('POST', '/orgs/org_acme/grants', { token: dana.token, body: { userId: 'usr_acme_admin', effect: 'deny', permissions: ['device:terminal'] } });
check('owner denies admin device:terminal org-wide', denyAdmin.status, 201);
const admin2 = await login('admin@acme.test');   // old token is stale now
check('admin cannot then grant device:terminal', (await call('POST', '/orgs/org_acme/grants', { token: admin2.token, body: { userId: 'usr_acme_viewer', deviceId: 'dev_lab_win_01', effect: 'allow', permissions: ['device:terminal'] } })).body.error.reason, 'scope_mismatch');
check('...nor device:* which contains it', (await call('POST', '/orgs/org_acme/grants', { token: admin2.token, body: { userId: 'usr_acme_viewer', effect: 'allow', permissions: ['device:*'] } })).body.error.reason, 'scope_mismatch');
check('admin\'s earlier token is stale', code(await call('GET', '/orgs/org_acme/devices', { token: admin.token })), '401 TOKEN_STALE');

console.log('\n== concurrency: the database picks exactly one winner ==');
const ownerAcme = await login('owner@acme.test');
const [c1, c2] = await Promise.all([
  call('POST', '/orgs/org_acme/sessions', { token: dana.token, body: { deviceId: 'dev_qa_android_01', mode: 'control' } }),
  call('POST', '/orgs/org_acme/sessions', { token: ownerAcme.token, body: { deviceId: 'dev_qa_android_01', mode: 'terminal' } }),
]);
check('two exclusive starts at once -> one 201, one 409', [c1.status, c2.status].sort(), [201, 409]);
const inv = await call('POST', '/orgs/org_acme/invites', { token: dana.token, body: { email: 'race@example.test', role: 'viewer' } });
const [a1, a2] = await Promise.all([1, 2].map(() => call('POST', `/invites/${inv.body.inviteToken}/accept`, { body: { name: 'Race', password: 'longenough1' } })));
check('two accepts of one invite -> one 200, one 409', [a1.status, a2.status].sort(), [200, 409]);
const dup = await call('POST', '/orgs/org_acme/invites', { token: dana.token, body: { email: 'twice@example.test', role: 'viewer' } });
check('second live invite for same email -> 409', (await call('POST', '/orgs/org_acme/invites', { token: dana.token, body: { email: '  TWICE@example.test ', role: 'viewer' } })).status, dup.status === 201 ? 409 : -1);

console.log('\n== suspension reaches ungated routes too ==');
const opLogin = await login('sam@example.test');                       // operator in Acme
const samSession = await call('POST', '/orgs/org_acme/sessions', { token: opLogin.token, body: { deviceId: 'dev_lab_mac_01', mode: 'view' } });
await call('POST', '/orgs/org_acme/members/usr_sam/suspend', { token: dana.token });
const samAgain = await call('POST', '/auth/refresh', { cookie: opLogin.cookie, body: { orgId: 'org_acme' } });
check('refresh into the suspended org -> 403 suspended', samAgain.body?.error?.reason, 'suspended');
const samDefault = await call('POST', '/auth/refresh', { cookie: opLogin.cookie });
check('refresh without orgId lands in an org where she is active', samDefault.body?.orgId, 'org_globex');
const samGlobexToken = samDefault.body.token;
check('...and her Globex work is unaffected', (await call('GET', '/orgs/org_globex/audit', { token: samGlobexToken })).status, 200);
check('her own session in Acme was ended', (await call('GET', `/sessions/${samSession.body.id}`, { token: dana.token })).body.end_reason, 'user_suspended');
await call('DELETE', '/orgs/org_acme/members/usr_sam/suspend', { token: dana.token });

console.log('\n== refresh rotation and replay ==');
const r1 = await call('POST', '/auth/refresh', { cookie: viewer.cookie });
check('first use of the cookie rotates it', r1.status, 200);
check('replaying the old cookie -> 401', (await call('POST', '/auth/refresh', { cookie: viewer.cookie })).status, 401);
check('...and the replay killed the new one too', (await call('POST', '/auth/refresh', { cookie: r1.setCookie.split(';')[0] })).status, 401);

console.log('\n== offboard and rehire ==');
await call('POST', '/orgs/org_acme/grants', { token: dana.token, body: { userId: 'usr_acme_viewer', deviceId: 'dev_lab_win_01', effect: 'allow', permissions: ['device:control'] } });
const v = await login('viewer@acme.test');
check('before: viewer controls lab-win-01 via a grant', (await call('GET', '/orgs/org_acme/devices', { token: v.token })).body.devices.find((d) => d.id === 'dev_lab_win_01').permissions['device:control'].effect, 'allow');
check('remove the viewer', (await call('DELETE', '/orgs/org_acme/members/usr_acme_viewer', { token: dana.token })).status, 204);
check('their token is refused (401)', (await call('GET', '/orgs/org_acme/devices', { token: v.token })).status, 401);
check('the users row survives; login still works', (await call('POST', '/auth/login', { body: { email: 'viewer@acme.test', password: 'demo1234' } })).status, 200);
const reinvite = await call('POST', '/orgs/org_acme/invites', { token: dana.token, body: { email: 'viewer@acme.test', role: 'operator' } });
check('re-invite the same email', reinvite.status, 201);
const rehired = await call('POST', `/invites/${reinvite.body.inviteToken}/accept`, { body: {} });
check('accept attaches the existing user (no new account)', rehired.body?.user?.id, 'usr_acme_viewer');
check('rehired as the invited role', rehired.body?.role, 'operator');
const again = (await call('GET', '/orgs/org_acme/devices', { token: rehired.body.token })).body.devices;
check('old grants did not come back (kiosk deny gone)', again.some((d) => d.id === 'dev_kiosk_lobby_01'), true);

console.log('\n== device transfer ==');
const newOrg = await call('POST', '/orgs', { token: dana.token, body: { name: 'Transfer Target' } });
check('self-transfer -> 400', (await call('POST', '/orgs/org_acme/devices/dev_build_server_01/transfer', { token: dana.token, body: { targetOrgId: 'org_acme' } })).status, 400);
check('to an org you are only a viewer in -> 403', (await call('POST', '/orgs/org_acme/devices/dev_build_server_01/transfer', { token: dana.token, body: { targetOrgId: 'org_globex' } })).status, 403);
check('to an org that does not exist -> 404', (await call('POST', '/orgs/org_acme/devices/dev_build_server_01/transfer', { token: dana.token, body: { targetOrgId: 'org_nope' } })).status, 404);
// The seeded session on this device was Sam's and the suspension above already ended it,
// so open a fresh one to watch the transfer end it.
const live = await call('POST', '/orgs/org_acme/sessions', { token: dana.token, body: { deviceId: 'dev_build_server_01', mode: 'control' } });
check('dana opens a control session on build-server-01', live.status, 201);
check('to an org where you provision -> 200', (await call('POST', '/orgs/org_acme/devices/dev_build_server_01/transfer', { token: dana.token, body: { targetOrgId: newOrg.body.id } })).status, 200);
check('the live session on it ended device_transferred', (await call('GET', `/sessions/${live.body.id}`, { token: dana.token })).body.end_reason, 'device_transferred');
check('Acme no longer lists it', (await call('GET', '/orgs/org_acme/devices', { token: dana.token })).body.devices.some((d) => d.id === 'dev_build_server_01'), false);

console.log('\n== measured: the device list does not grow in queries ==');
const db = new Database(DB);
const ins = db.prepare("INSERT INTO devices (id, org_id, name, kind) VALUES (?, 'org_acme', ?, 'linux')");
db.transaction(() => { for (let i = 0; i < 500; i++) ins.run(`dev_bulk_${i}`, `bulk-${String(i).padStart(3, '0')}`); })();
db.close();
const timeList = async () => {
  const t = performance.now();
  const r = await call('GET', '/orgs/org_acme/devices', { token: dana.token });
  return { ms: performance.now() - t, n: r.body.devices.length };
};
await timeList();   // warm
const samples = [];
for (let i = 0; i < 5; i++) samples.push(await timeList());
const median = samples.map((s) => s.ms).sort((a, b) => a - b)[2];
console.log(`       ${samples[0].n} rows, median of 5: ${median.toFixed(1)} ms`);
check('500+ device rows in under 250 ms', median < 250, true);

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
server.kill();
for (const s of ['', '-wal', '-shm']) if (existsSync(DB + s)) rmSync(DB + s);
process.exit(fail === 0 ? 0 : 1);
