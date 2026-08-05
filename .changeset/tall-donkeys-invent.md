---
"sinscribe": minor
---

Carry a prompting session forward with `HANDOFF.md`

After you approve a feature/bugfix prompt, `sinscribe prompt` now offers to write a
`HANDOFF.md` at the repo root — a snapshot of where the branch stands (what was
done, what was decided, what is still open), not an accumulated log. The draft is
model-written and reviewable in the same approve/modify loop as the prompt itself;
the `## Last updated` date is stamped by the CLI rather than asked of the model.

The next `sinscribe prompt` on that branch reads the file back and feeds it to the
model, so a second iteration starts warm instead of re-deriving settled ground. A
handoff written on a different branch is still passed along, but labeled as such
rather than presented as the current state.

Adds `--handoff` to write the file without asking — the only route in `-p/--print`
and other non-TTY runs, which cannot ask. `--dry-run` reports whether a handoff
would be read back in and whether one would be written.
