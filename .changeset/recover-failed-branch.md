---
"sinscribe": minor
---

Add `sinscribe recover` to take over a branch an automated pipeline could not finish. It fetches, finds the branch from a ticket or its name, and opens it in place or in its own worktree (`--worktree`). The AI then reads what the pipeline left (specs, plans, logs, its commits, and an optional `--from` diagnosis), read-only, and drafts the branch's session context as a takeover brief with `Failure:` and `Remaining:` lines. It never proposes weakening the tests. After you approve it, continue with a quick bugfix prompt or the spec plan. The menu gains **Recover a failed branch** for the current branch, and `-p --save` drafts and saves the context without review for scripts.

Small terminals are handled better along the way. The header's brand line and subtitle no longer wrap past the rows reserved for them. The AI session-context screens drop their extra lines instead of growing taller than the terminal (which froze the CLI). An approved context is no longer dropped when it is approved before the menu finishes reading the repository.
