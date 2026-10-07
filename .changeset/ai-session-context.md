---
"sinscribe": minor
---

Add "Generate session context with AI" to the menu. You give the direction — what the session is for — and the AI backs it with evidence from the repository: code and markdown documents (reports, notes, specs, handoffs), read-only with every provider that can explore (the claude CLI under `--restricted`, a write-denied agent for API-key providers) and from the repo brief plus matching doc excerpts otherwise. The draft shows its sources and open questions; refine the goal, add details or answers, send it back into the repository, edit it by hand, then approve — nothing is saved before that. A branch without a context now asks whether to generate it with AI or write it manually.
