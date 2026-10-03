---
"sinscribe": minor
---

🐛 Fix OpenCode Go requests failing with `400 Request is missing
x-opencode-session`. OpenCode Go now routes only clients that identify
themselves, so every request sends `User-Agent: sinscribe/<version>`,
`x-opencode-client: sinscribe` and an `x-opencode-session` id: one per
single-shot run, and the conversation's thread id for agentic commands, so
`chat` keeps one session across turns. The settings **Test connection** probe
sends the same headers.

✨ Add the `claude-cli` provider: drives your signed-in Claude Code CLI
(`claude -p --output-format stream-json`) the way `kiro-cli` drives Kiro, so
`pr`/`commit`/`branch`/`prompt` can use a Claude subscription with no API key.
It runs with no tools and isolated from your Claude Code settings, hooks, MCP
servers, skills and repository `CLAUDE.md`; models are the CLI aliases
`sonnet` (default), `haiku`, `opus` and `fable`.
