# DECISIONS

One section per decision that a reviewer might reasonably have made differently. Every section has
the same four parts, and the third and fourth are the ones we weigh most.

Rules, from `DISCOVERY-BRIEF.md`:

- cite something real in `Why` — a commit, a test, an error string, a file and line
- do not restate what a document says; describe what you did when the documents ran out
- six to twelve decisions is the expected range

---

<!-- decisions appended below as they are made -->

### The verifier checks the signature before it parses the payload, and validates base64url strictly

**What I chose:** `verifyAccessToken` (`starter/server/auth.js`) decodes the header, pins
`alg=HS256`/`typ=JWT`, compares the HMAC with `timingSafeEqual`, and only then parses claims.
Every segment must match `/^[A-Za-z0-9_-]+$/` before it is decoded.
**Why:** Node's base64url decoder is lenient — `'Q!UJD'` and `'QUJD'` decode to the same bytes
(BUILD-LOG Phase 1, 17:58). Without the regex a signature can be mutated without invalidating
it, so a token string is not a unique identity for a token.
**What I rejected:** parse header and payload first, then verify (the common tutorial order). It
passes `check-jwt.js` equally, but runs `JSON.parse` on unauthenticated input and makes it easy
to accidentally branch on an unverified claim.
**What would change my mind:** needing to accept tokens from another issuer with a different
alg — then the key/alg would be chosen by our config per issuer, still never by the header.


### The org-level view counts device-scoped allows but never device-scoped denies

**What I chose:** `resolve(..., deviceId=null)` (`evaluateOrgView` in `permissions.js`) starts
from the org-wide answer and lifts an *implicit* deny when a device-scoped allow is effective on
its own device. Org-wide denies are never lifted; device-scoped denies do not spread upward.
**Why:** the acme viewer has `device:view` denied on one kiosk and allowed on four other rows;
"deny anywhere → deny org-level" would remove their Devices nav while rows are visible. And the
viewer's one-device `session:start` must light the Sessions "start" entry — `check-engine.js`
"viewer: session:start org-level".
**What I rejected:** one scope for everything. Using the union for `assertMayGrant` lets a
one-device allow be regranted org-wide — `check-engine.js` "may NOT grant it org-wide from a
one-device grant" fails under it. So the union is display-only.
**What would change my mind:** a requirement that org-level nav reflect "allowed on every
device" rather than "on some device".

### Session refusals name the missing half, not the deny kind

**What I chose:** `assertCanStartSession` resolves the device once and refuses with
`missing_permission` (no `session:start`) or `missing_device_permission` (no mode permission),
even when the cause is an explicit deny; the message says "explicitly denied" vs "not granted".
**Why:** the brief requires the refusal to say *which* permission was missing
(`check-api.js` §9 reads those two strings). One reason field cannot carry both facts.
**What I rejected:** `reason: explicit_deny` whenever a grant denied it — the caller can then no
longer tell "you cannot open sessions here at all" from "not on this device".
**What would change my mind:** an error shape with a second field (e.g. `permission`) the tests
accept; then both facts could be machine-readable.

### No role is named in code — "owner" is the top rank in `roles`

**What I chose:** `ownerRole(db)` in `lifecycle.js` is `ORDER BY rank DESC LIMIT 1`; creator-
becomes-owner, last-owner protection and "only an owner confers owner" all use it. Rank rules
read `roles.rank`. `grep -rn "'owner'\|'admin'" starter/server starter/web` finds two hits, neither
a role check: a comment in `lifecycle.js` and the Admin *card* key in `web/App.jsx`.
**Why:** grading swaps the fixture; my overlay already added `reviewer` at rank 35, between admin
and operator. A literal `'owner'` would be the one place the matrix leaked into code.
**What I rejected:** `role === 'owner'` checks — correct on every documented fixture, and exactly
the kind of assumption the personalisation exists to catch.
**What would change my mind:** a fixture whose top-ranked role is not meant to own orgs — then
ownership would need its own column or flag in `roles`.

### The path's org is checked against the token before any lookup

**What I chose:** `context.js` throws 404 when `params.org !== claims.org`, before reading the
membership or the resource.
**Why:** isolation is structural — the check does not depend on each route remembering a
`WHERE org_id = ?`, and it reveals nothing about whether the other org or resource exists.
`check-api.js` "D18 Acme token cannot address the new org" and the cross-org 404s.
**What I rejected:** looking the resource up and comparing its `org_id` (403/404 per route).
It works only as long as every route does it, and it touches the other org's data to decide.
**What would change my mind:** an endpoint that must legitimately span orgs with one token —
transfer is the only one, and it resolves the target org from the caller's membership there.

### The database decides races; the code catches its answer

**What I chose:** no check-before-insert for exclusive sessions or live invites; the insert is
attempted, and `SQLITE_CONSTRAINT_UNIQUE` becomes 409. Unknown permissions: the FK on
`grant_permissions` refuses, caught as `400 unknown_permission`. Invite accept flips with
`WHERE accepted_at IS NULL AND revoked_at IS NULL` and requires `changes === 1`.
**Why:** `check-edges.js` fires two exclusive starts and two accepts with `Promise.all` — one
winner each time. A SELECT-then-INSERT has a window between the two.
**What I rejected:** checking first "for a nicer error". I kept one check-first case where there
is no index to lean on (device names, `assertNameFree`) and listed it as an open thread.
**What would change my mind:** moving off SQLite's single writer to something where the partial
index semantics differ — I would re-run the concurrency cases before trusting it.

### Removal revokes the member's grants; rehire starts from the invited role

**What I chose:** `removeMembership()` in `routes/orgs.js` revokes the user's live grants in that
org alongside `status='removed'`, the version bump and ending sessions.
**Why:** accept reactivates the same `memberships` row (`UNIQUE(org_id, user_id)`), and grants
are keyed by user, not membership — without the revoke, a rehire silently inherits every old
allow and deny. `check-edges.js` "old grants did not come back".
**What I rejected:** leaving grants as history. Revoked rows *are* the history (`revoked_at`),
and live rows would be live authority.
**What would change my mind:** a product rule that suspension-like "come back as you were" is
wanted for removal — then removal should just be suspension.

### Audit refusals are written by one wrapper; successes by the handler's transaction

**What I chose:** `on()` in `routes/index.js` wraps every authenticated handler in
`auditDenials`; handlers write their own success row inside their transaction.
**Why:** a refusal row must exist even though the handler threw (so it cannot be in the
handler's transaction), and one wrapper means no route can forget. Success inside the
transaction means a rolled-back change leaves no row claiming it happened.
**What I rejected:** a wrapper that also writes the success row — it would log an allow even
when the handler's transaction rolled back, and double-log for handlers that already audit.
**What would change my mind:** needing the refusal row to be atomic with something else.
---

## Where this repo argues with itself

1. **Equal-rank modification.** PERMISSIONS §6: "modify a user of equal role (admin → admin) |
   403". `check-api.js:150`: owner demoting another owner → 200. Built: equal rank refused
   *except* for the owner role (`assertCanModify` in `lifecycle.js`). Why: otherwise a second
   owner is irremovable; last-owner protection covers the real risk. (BUILD-LOG 18:08)
2. **"`device:*` collapses to the seven device permissions"** (PERMISSIONS §4). False for any
   database with the personalisation overlay: mine has `device:reboot`, so `device:*` is 8.
   Built against the schema: `expandPattern` reads `permissions.resource`.
3. **Not a member → 401** (PERMISSIONS §5) vs **cross-org → 404** (§5 and `check-api.js:72`).
   Both hold once "not a member" is read as *of the token's own org*: a path naming another org
   is 404 before any lookup (`context.js`); a token whose own membership is gone is 401.
4. **"a NEW session is now blocked"** (`check-api.js:128`) asserts **401**, not 403. The demotion
   bumped `perm_version`, so the token is stale before the permission check is reached. Built
   as the test says; the order in `context.js` makes it so.
5. **Invites "flip the membership from `invited` to `active`"** (AUTH-DATA-MODEL §6), but
   `memberships.user_id` is a NOT NULL FK to `users` and an invitee may have no user yet. Built:
   no `invited` rows; the membership is created, or a `removed` one reactivated, on accept.
6. **"A token for a suspended membership → 403 with an empty permission set"** (AUTH §10) vs the
   single error shape (§5). Built: 403 `FORBIDDEN`/`suspended` in the standard shape; the
   engine's answer for a suspended member is every permission denied with `reason: suspended`.
7. **`end_reason = 'superseded'`** is allowed by the schema and mentioned in no document. Not
   produced by anything; left alone.

## Deliberately not built

- **Caching of resolved permissions.** Measured 5.7 ms for 504 device rows with fresh
  resolution (BUILD-LOG 19:22). A cache would add the one failure mode the brief warns about —
  stale authority — to save time nobody can see.
- **Pagination on devices, members, grants.** Audit has it (it grows without bound); the others
  are bounded by what an org owns and measured fine at 500+.
- **File transfer, and anything that touches a real device.** Ground rule: sessions are records.
- **Password reset, email delivery, rate limiting.** Out of scope per the starter README; invite
  tokens are shown in the console once instead of emailed.
- **A leave-org button in the console.** The endpoint exists and is tested
  (`check-api.js` LAST_OWNER); the UI was cut for time.

## Tools and sources

- **Claude Code (Anthropic), used as an AI pair programmer for the whole build.** It read the
  hand-out, proposed the implementation, wrote code and ran the suites; every change was
  committed in small steps so the history shows the order things happened in. I reviewed each
  step and I am accountable for every line.
- **Not used:** `q1-starter/` (the reference implementation shipped by mistake in the public repo)
  and `DISCOVERY-RUBRIC.md`. Both were deleted unread in the first commit.
- Libraries: only what `starter/package.json` already declares (`better-sqlite3`, React, Vite,
  Playwright). No new dependencies.
