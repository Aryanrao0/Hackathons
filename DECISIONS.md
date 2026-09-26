# DECISIONS

One section per decision that a reviewer might reasonably have made differently. Every section has
the same four parts, and the third and fourth are the ones we weigh most.

Rules, from `DISCOVERY-BRIEF.md`:

- cite something real in `Why` — a commit, a test, an error string, a file and line
- do not restate what a document says; describe what you did when the documents ran out
- six to twelve decisions is the expected range

---

<!-- decisions appended below as they are made -->

---

## Where this repo argues with itself

The documents contradict each other, or contradict the schema, in at least one place. Name each
one you found. For each: quote both statements, say which you built against, and say why.

Building against the written rule and arguing in writing is a **full-marks** answer. Silently
working around it, or quietly picking one and saying nothing, scores zero on the section — we
cannot tell the difference between a decision and an oversight.

## Deliberately not built

What you chose not to build, and the reason. A scope cut with a stated reason is a senior
judgement. An unmentioned gap is a gap.

## Tools and sources

- **Claude Code (Anthropic), used as an AI pair programmer for the whole build.** It read the
  hand-out, proposed the implementation, wrote code and ran the suites; every change was
  committed in small steps so the history shows the order things happened in. I reviewed each
  step and I am accountable for every line.
- **Not used:** `q1-starter/` (the reference implementation shipped by mistake in the public repo)
  and `DISCOVERY-RUBRIC.md`. Both were deleted unread in the first commit.
- Libraries: only what `starter/package.json` already declares (`better-sqlite3`, React, Vite,
  Playwright). No new dependencies.
