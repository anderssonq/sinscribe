---
"sinscribe": minor
---

Add `sinscribe plan` and the "Spec plan (SDD)" menu item: spec-driven development for the current branch. Requirements → design → tasks → handoff are generated from the session context, reviewed and approved in order, and written to `specs/<branch>/` with an `index.md` that tracks approval and staleness. Requirements and design can read the repository first, read-only (the claude CLI under `--restricted` with Read/Glob/Grep, or a write-denied agent for API-key providers), with a single-shot fallback and `--no-explore`. `tasks.md` is validated for AC coverage and dangling references, and approving it writes `LOOP_PROMPT.md`, a task-by-task contract for your coding agent. `--approve`, `--sync` and `--loop-prompt` run offline.
