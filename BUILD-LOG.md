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

### 2026-09-26 18:05 IST · starting line
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

_What did you expect each failure mode to look like before you ran it? Which one behaved
differently from your expectation, and what did that tell you?_

## Phase 2 — caller context and the resolution engine

_This is where most people's first model is wrong. Write down the model you started with, the
observation that broke it, and the model you moved to. Be specific about the observation._

## Phase 3 — orgs, members, invites

_Anything you had to work out that no document states. Invite lifecycle states are a common
source of this._

## Phase 4 — devices and grants

_What happens at the boundary where two grants disagree, or where a grant's scope and the
question's scope differ? Say what you predicted and what you got._

## Phase 5 — sessions

_Two permissions, one device. What did you have to resolve, and in what order, to keep the two
failure reasons distinguishable?_

## Phase 6 — audit

_What did you decide counts as an auditable event, and what pushed you to that line?_

## Phase 7 — the console

_Where did the server's answer and your instinct disagree about what should be on screen?_

## Phase 8 — hardening

_What did you measure, what did you fix, and what did you deliberately leave alone? Anything you
chose not to build belongs here with its reason._

## Open threads

_Things you know are wrong, unfinished, or that you would do differently with another day. Listing
these honestly is worth more than pretending they do not exist — we will find them anyway._
