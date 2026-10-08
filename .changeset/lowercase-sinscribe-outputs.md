---
"sinscribe": minor
---

Generated markdown now lives in `.sinscribe/` with lowercase names, so nothing lands at the repo root anymore: `.sinscribe/handoff.md`, `.sinscribe/pr-description.md`, `.sinscribe/agent-prompt.md`, `.sinscribe/project-documentation.md`, and spec plans in `.sinscribe/specs/<branch>/` with `loop-prompt.md`. An existing root `HANDOFF.md` is still read as context until the next save writes the new file. A plan still in `specs/<branch>/` stops `sinscribe plan` with the exact `git mv` to move it, rather than starting a second plan.
