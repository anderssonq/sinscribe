---
"sinscribe": patch
---

Kiro explorations no longer fail when Kiro throttles them. A throttled exploration (session context with AI, or the plan's requirements and design stages) now drafts from the repository summary instead, and says so. A failed `kiro-cli` or `claude` run now shows its real error line instead of the first lines of tool progress, and "throttled" counts as a rate limit, so single-shot calls retry it. Spec plan documents no longer start with the model's narration ("Now I have enough context…"): everything before the stage's first section is dropped.
