---
"sinscribe": minor
---

Agent-facing output now follows tracked standards. `agents --target both` writes `AGENTS.md` as the canonical file and a `CLAUDE.md` that imports it with `@AGENTS.md`, so they no longer drift apart. `agent-setup` stops pinning `model: sonnet` (definitions inherit the session's model) and gives read-only roles a restricted `tools:` list. Both commands check what they wrote (frontmatter, name shape, line limits) and list any problem under "Standards check". Spec plans name EARS notation and stamp the standards they follow in their header. `agents --dry-run` lists which tools read `AGENTS.md` natively (Codex, Claude Code, Kiro, Cursor, GitHub Copilot, Gemini CLI) and how.
