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
(BUILD-LOG Phase 1, 18:20). Without the regex a signature can be mutated without invalidating
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
---

## Where this repo argues with itself

1. **Equal-rank modification.** PERMISSIONS §6: "modify a user of equal role (admin → admin) |
   403". `check-api.js:150`: owner demoting another owner → 200. Built: equal rank refused
   *except* for the owner role (`assertCanModify` in `lifecycle.js`). Why: otherwise a second
   owner is irremovable; last-owner protection covers the real risk. (BUILD-LOG 20:40)
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
  resolution (BUILD-LOG 22:20). A cache would add the one failure mode the brief warns about —
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
