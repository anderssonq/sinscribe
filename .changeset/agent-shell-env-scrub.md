---
"sinscribe": patch
---

Harden the agentic commands (`context` / `agents` / `chat`): the shell tool no longer inherits the process's secret API-key environment variables, so repository content can no longer read or exfiltrate credentials through the shell. The user's PATH / HOME / SSH / git environment is preserved, so git and normal tooling keep working.
