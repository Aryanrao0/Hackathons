# BUILD-LOG

Append to this as you go. Commit it with the code it describes — the timestamps are part of the
evidence, and a log that arrives in one commit at the end reads as what it is.

Five lines is a real entry. Short and dated is better than long and reconstructed.

The categories we look for are listed in `DISCOVERY-BRIEF.md`. The example below shows the
*shape* of a good entry; it is a recreation of something already printed in `README.md`, so it
gives nothing away.

---

## Phase 0 — orientation

### 2026-09-26 17:56 IST · repo cleanup before any code
The fork of `rhinostream/Hackathons` contains more than the hand-out: the top-level README is the
organisers' file and says `q1-starter/` is the reference implementation and `DISCOVERY-RUBRIC.md`
is organiser-only. Did not open either. Removed both (plus `tools/`, `HARDENING.md`) in the first
commit so nothing from them can end up in this repo; built only from `starter/` and the
candidate-facing docs. Flagging it to the organisers by email.
Working with Claude Code (AI pair) throughout — see `DECISIONS.md` › Tools.

### 2026-09-26 17:58 IST · starting line
`npm install`, `npm run db:reset` on Node 22.16. Loader printed `permissions=20 patterns=27`, not
the 19/26 the reference.sql comment promises: my overlay (nonce `starter-demo`) adds role
`reviewer` at rank 35 and permission `device:reboot`.
Consequence I did not expect: the extra permission is a *device* permission, so `device:*` must
expand to 8 permissions here, and PERMISSIONS.md §4 ("`device:*` collapses to the seven device
permissions") is wrong for this database. Wildcards have to be expanded from the table.
Rank 35 sits between admin (40) and operator (30), so the rank rules must read `roles.rank` too.
Suites against the untouched skeleton:
- `check-jwt.js` 0/43 — every case throws the NOT_IMPLEMENTED error, not a 401.
- `check-permissions.js`, `check-personalisation.js` — crash on the `resolve()` stub.
- `check-api.js` — first failure is `dana logs in: got 404`, not a 401. I expected auth to be the
  first wall; it is the empty route table. Login is ours to write too, not only verification.

## Phase 1 — token verification

### 2026-09-26 17:58 IST · verifyAccessToken
Order chosen: header → signature → payload. The payload is not `JSON.parse`d until the HMAC
matches, so unauthenticated bytes never reach the parser. `check-jwt.js`: 43/43 on first run.
Prediction I had not tested: that `Buffer.from(x, 'base64url')` rejects junk. It does not.
Checked in a REPL: `'!!!not-base64!!!'` decodes to 7 bytes of garbage, and `'Q!UJD'` decodes to
the *same bytes* as `'QUJD'`. So without the `B64URL` regex in `auth.js`, a valid signature
with a `!` spliced in still verifies — many different token strings, one signature. The suite
would still pass (the junk case fails on length), which is why the regex matters and the test
did not show it. Kept the regex on header, payload and signature.
Also added: `sub`/`org` must be strings and `pv` an integer. Not in the TODO list, but
`context.js` will rely on them, and a malformed-but-signed token should be a 401, not a 500.

## Phase 2 — caller context and the resolution engine

### 2026-09-26 18:01 IST · resolve(): one loader, one pure evaluator
Model I started with: `resolve()` answers one (user, org, device?) question with its own
queries. Problem I saw before writing it: `resolveDevices` for N rows would then cost 4N
queries. Split it: `loadInputs()` reads catalogue + membership + baseline + ALL live grants
(4 queries), `evaluate(inputs, deviceId)` is pure. Both public resolvers call the same pair.
`check-permissions.js` 35/35 and `check-personalisation.js` 18/18 on first run — no wrong
prediction from the suites here, so I went looking for cases they do not cover.
Ran the personalisation check with 8 different `CANDIDATE_NONCE`s (grading uses another one):
all 18/18, including draws where the extra permission is `session:replay` rather than `device:*`.

### 2026-09-26 18:01 IST · the documents leave the org-level view open
PERMISSIONS §3 says org-level is "the union across all devices" but not what a device-scoped
DENY does to it. Two readings: (a) any deny anywhere → org-level deny; (b) union of allows.
(a) would hide the Devices nav from the acme viewer because of one denied kiosk, while 4 other
rows are visible — wrong. Chose (b): start from the org-wide answer, lift an *implicit* deny if
a device-scoped allow is effective on its own device; never lift an explicit org-wide deny.
Separately: for "may you grant this org-wide" the union is the WRONG scope — a viewer with
session:start on one device would pass. So there are three scopes, not two: device, strict
org-wide (`assertMayGrant`, `assertCan` without a device), and the union view (`resolve` with
`deviceId=null`). Wrote `scripts/check-engine.js` for these (15 cases).

### 2026-09-26 18:01 IST · a test of mine that could not fail
Reviewing `check-engine.js`: "dana: the old acme grant does not apply in globex" passed — but
that grant belongs to the acme viewer, not Dana, so it would pass with no transfer logic at
all. Deleted it. The real transfer risk (a device moved out of org A still lifting org A's
union view through its old grant) is the check above it, and that one does depend on the
`d.org_id = g.org_id` join in `loadInputs`.

### 2026-09-26 18:04 IST · context, lifecycle, audit — and a reversed decision
REVERSED the org-view choice logged at 18:01 that `assertCan` with no device uses the strict org-wide scope.
While listing the routes I hit the viewer who holds `session:start` only on lab-mac-01: the
nav (union view) shows "start a session", but a strict gate on the endpoint would 403 it —
the console and the API would disagree about the same person. Now `decision()` in
`permissions.js` uses the union view for every device-less gate; the strict scope survives
in exactly one place, `assertMayGrant`. All four suites still green after the change.
`context.js` check order: verify → path org ≠ token org is 404 *before any lookup* → membership
gone/removed 401 → pv 401 TOKEN_STALE → suspended 403 except four person-level routes
(`SUSPENDED_OK`). I had to pass the route key into `authenticate()` for that last one —
one-line change to the given `index.js`.
`lifecycle.js` names no role: "owner" is `ORDER BY rank DESC LIMIT 1`. Found while writing it:
an expired `control` session that nobody ended keeps `state='active'`, so the partial unique
index would block that device forever. Added `expireSessions()` to run before session reads and
inserts.

## Phase 3 — orgs, members, invites

### 2026-09-26 18:08 IST · two transaction bugs in /auth/refresh, caught on read-back
Both found reading my own code before running it, not by a test:
1. The rotated refresh cookie was set on `res` *inside* the transaction. If `sessionBody()`
   then threw (e.g. `orgId` you are not in), the new row rolled back but the error response
   still carried its cookie — a credential for a row that does not exist; the next reload
   would log the user out. Now `newRefreshRow()` returns the raw token and the cookie is set
   after commit.
2. On a concurrent-refresh race I called `revokeFamily()` then `throw` inside the same
   transaction — the throw rolls back the revocation, so replay detection did nothing.
   The transaction now returns `null` and the family is revoked outside it.
Same lesson twice: inside `db.transaction`, a throw undoes every side effect *in the DB*, and
none of the side effects *outside* it.

### 2026-09-26 18:08 IST · check-api 65/66 — the docs and the test disagree on owners
Predicted all of D8 would pass: I had implemented PERMISSIONS §6 literally, "modify a user of
equal role → 403". Got `demoting a NON-last owner is allowed: got 403 want 200`
(`check-api.js:150`, owner Dana demoting owner@acme). Equal rank, and the test wants 200.
The test is the better rule: with strict "higher rank only", a second owner can never be
demoted or removed by anyone, and `assertNotLastOwner` already protects the case that matters.
Changed `assertCanModify`: the owner role (top rank) may modify anyone; everyone else needs
strictly higher rank. 66/66, and the other four suites unchanged.
Membership lifecycle choices the docs leave open: invites do NOT create `status='invited'`
membership rows — the membership needs a `users` row and the invitee may not have one yet, so
the row is created (or a `removed` one re-activated) at accept. Removal revokes the member's
grants in that org, so a rehire starts from the invited role, not the old grants.

## Phase 4 — devices and grants

### 2026-09-26 19:23 IST · (written after the fact about commit 68cd826)
Devices, grants and sessions were written in one sitting and committed together with the rest
of the API, so there is no separate commit per phase — noting that rather than pretending.
Grant create checks in this order: shape (400) → device/user visible (404) → `grant:create`
(403) → self-grant (403) → `assertMayGrant` (403) → insert, where the FK rejects unknown
strings. Consequence I noticed: `['device:teleport']` expands to nothing, so the laundering
check passes vacuously and the FK is what refuses it — `400 unknown_permission`, as
`check-api.js` expects. With `['device:teleport','org:delete']` an admin gets the 403 first.
Transfer revokes the old org's grants on the device instead of leaving them inert: the engine
already ignores them (the `d.org_id = g.org_id` join), but inert rows would come back to life if
the device were ever transferred back.
## Phase 5 — sessions

### 2026-09-26 19:23 IST · (after the fact, commit 68cd826)
`assertCanStartSession` resolves the device ONCE and reads both answers from that one result,
`session:start` first: if both are missing the caller hears about the one that applies
everywhere, and the viewer on qa-android-01 gets `missing_permission` while the same viewer's
`control` on lab-mac-01 gets `missing_device_permission` (check-api §9).
Exclusivity is not checked before the insert — the insert is attempted and a
`SQLITE_CONSTRAINT_UNIQUE` from `one_exclusive_session_per_device` becomes `409 DEVICE_BUSY`
with the holder's id. Proven under concurrency later in `check-edges.js` (one 201, one 409).
## Phase 6 — audit

### 2026-09-26 19:23 IST · (after the fact, commit 68cd826)
Line drawn: a success row is written by the handler inside its own transaction; a refusal row is
written by `auditDenials`, which `routes/index.js` wraps around every authenticated route. So a
new route cannot forget to audit its denials. Refusals = 403s plus the 409s that are the system
saying no (`LAST_OWNER`, `DEVICE_BUSY`). Not 404s: a probe of another org's id would otherwise
write a row describing it into the caller's own org's log. Public routes (login, invite
accept) have no caller org and are not wrapped; failed sign-ins are therefore not audited —
see Open threads.
## Phase 7 — the console

### 2026-09-26 18:44 IST · console built against the server's answers only
Needed a role list for the role/invite selects and there is no endpoint for it; typing the
five roles into `web/` would be exactly the hardcoded matrix the brief forbids, and would miss
`reviewer`. Added `GET /v1/roles` (reads the table). The grant form's permission checkboxes
are the keys of `/auth/me`'s `permissions` object — the server's catalogue — so
`device:reboot` is offered without the console knowing it exists.
Anticipated bug, designed out before it happened: the boot path calls `/auth/refresh`. Two
refreshes with the same cookie (React effects running twice, two quick reloads) would make
the server see the second as a replay and revoke the family — logging the user out on reload.
`refreshSession()` in `web/api.js` keeps one request in flight.
Cards are keyed `${orgId}:${card}` so an org switch remounts them with empty state — the
"no other org's content in the DOM" guarantee comes from that, not from clearing fields.
Result: `npm run build && npx playwright test` 25/25 on first run. Smoke-tested
`npm run dev` separately (Vite middleware): `/` and `/invite/x` 200, personalised `reviewer`
user logs in.

## Phase 8 — hardening

### 2026-09-26 19:22 IST · scripts/check-edges.js — 41/43, both wrong predictions were mine
Wrote 43 HTTP cases for seams `check-api.js` does not reach: malformed Authorization headers,
cross-org ids on id-only routes, grant validation, laundering across scope, concurrent starts
and accepts, suspension, refresh replay, offboard/rehire, transfer.
Two failures, neither a server bug:
- Predicted a 20 KB bearer token → 401 from `verifyAccessToken`. Got **431**: Node's HTTP
  parser rejects headers over 16 KB before `index.js` runs. Correct behaviour (not a 500);
  the test now asserts 431 and says why.
- Predicted the seeded `ses_live_build_server` would end `device_transferred`. Got
  `user_suspended` — it is Sam's session, and my own suspension case earlier in the same run
  had already ended it. The cascade was right; my test's ordering was wrong. The transfer case
  now opens its own session first.
44/44 after. Things these confirmed that I had only reasoned about: two simultaneous exclusive
starts → exactly one 201 + one 409 (the partial index, no check-first code); two simultaneous
accepts of one invite → one 200 + one 409; replaying a rotated refresh cookie kills the new one
too; a removed-then-reinvited user comes back with the invited role and none of the old grants
(the kiosk deny is gone).

### 2026-09-26 19:22 IST · measured the device list
Inserted 500 extra devices into Acme: `GET /orgs/org_acme/devices` returns 504 rows, median of 5
runs **5.7 ms** after one warm-up (M-series laptop, production mode). Query count per request is
fixed: 1 device query + 4 in `loadInputs()`, whatever the row count. No cache: resolution is
fresh per request, so there is no stale-authority question to answer.

### 2026-09-26 21:22 IST · `npm run dev` restarted itself forever — found by opening it in a browser
Every test suite runs the server with plain `node` (production mode), and my earlier dev smoke
test did too, so none of them used `node --watch`. Opening the app with `npm run dev` showed
"Restarting 'server/index.js'" ~20 times in 8 s with no requests, then hanging on
"Waiting for graceful termination".
Wrong turns, in order: (1) the DB file in `starter/` triggering the watcher — no: touching a
file in `starter/` caused 0 restarts. (2) the data — an empty DB showed 0 restarts, but only
because the server crashed on startup (no tables), so there was nothing to restart; a
misleading comparison. (3) the open browser tab reconnecting — no: port 8093, no browser,
still 15 restarts. A plain `fs.watch` on `server/` saw no events at all, so the trigger was
outside it.
Cause: watching `node_modules/.vite-temp` caught `rename vite.config.js.timestamp-….mjs`. Vite
bundles its config to a temp file, imports it, deletes it; `node --watch` tracks imported files,
sees one vanish, restarts — and the restart loads the config again.
Fix: `configLoader: 'native'` on `createServer` in `server/index.js` (Vite 6.4.3): the config is
imported as-is, no temp file. After: 0 restarts idle and after requests; touching
`server/router.js` restarts once and settles. Lesson: "all suites green" said nothing about the
command the graders actually type.

## Correction — 2026-09-26 21:12 IST (commit e9615d7; this heading itself first said 19:35 — also a guess)

The heading times above were first written as estimates, not read from a clock, and several
were hours later than the work (e.g. "22:35" for work committed at 19:23). Every heading now
carries the time of the commit that contains that work — `git log --date=format:%H:%M` is the
source. Separately, at 19:27 the eight commits were rewritten to drop a `Co-Authored-By: Claude`
trailer (dates and content unchanged); commit ids changed, and the three references to the old
API commit now name `68cd826`. Claude Code's role is stated in `DECISIONS.md` › Tools.

## Open threads

- Failed sign-ins are not audited: `audit_events.org_id` is NOT NULL and a failed login has no
  org. A per-user security log would need a table the schema does not have.
- Rank rules do not apply to grants: an admin may create a deny grant on an owner (the laundering
  rule still stops granting what they lack). The documents list the grant checks without a rank
  rule, so I followed them; I would argue for adding one.
- Device name uniqueness is a check-then-insert in `assertNameFree` — there is no unique index to
  lean on and I am not allowed to change the schema. Two concurrent creates can both win.
- `transfer-files` is present per permission but does nothing beyond explaining itself: there is
  no file transfer to perform (no real remote access).
- Deleting an org leaves members' refresh tokens valid; they refresh into another org, which is
  the intended outcome, but it is not tested beyond the UI flow.
