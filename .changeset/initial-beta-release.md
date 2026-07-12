---
"sinscribe": minor
---

Initial versioned beta release of Sinscribe, a git-centric developer-workflow CLI for generating PR descriptions, commit messages, branch names, and project/agent context briefs. Inspired by openwiki.

This changeset covers the work already on `main` but never versioned:

- Initial public release of the CLI: single-shot `pr` / `commit` / `branch` commands and agentic `context` / `agents` / `chat` commands, over a provider registry, a three-tier template system, and a config/secrets layer.
- PR flow: template preview and scrollable full-text review.
- Hardened prompt-kind inference and the `pr` prompt rules.
