---
"sinscribe": minor
---

# ✨ feat: "Rules" — author-defined instructions for every AI command

A new menu item, **Project rules** (CONFIG section), lets you write free-text
rules that get added to the system prompt of every LLM-backed command —
`chat`, `pr`, `commit`, `branch`, `prompt`, `context`, `docs`, and `agents`.

- Pick "Your rules" (personal, `~/.sinscribe/rules.md`, applies to every repo)
  or "Project rules" (team-shared, `<repo>/.sinscribe/rules.md`, meant to be
  committed) and edit them in a multi-line textarea, same as the session
  context wizard.
- **Both tiers combine additively** when both exist — your personal
  preferences and the repo's rules both apply, labeled separately, rather than
  one silently replacing the other (unlike the template system's
  highest-tier-wins behavior).
- Every `--dry-run` output gains a `Rules:` line summarizing what's active.
- No rules files present ⇒ zero behavior change: every existing system prompt
  is byte-identical to before.

`pr`/`commit`/`branch` still make exactly one model call each via
`runSingleShot`, with no tools or checkpointer — rules are plain text read
from local files before that one call, same as the diff or branch name.
