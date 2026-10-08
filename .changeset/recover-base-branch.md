---
"sinscribe": patch
---

`recover` now refuses the base branch (`main`, `develop`…) in the CLI, the dry run and the menu, and asks for the failed branch or its ticket. Recovering the base branch used to read a tree without anything the pipeline wrote, so the draft and the spec plan built on it planned around work that already existed. The pre-filled recovery goal no longer becomes the title of the context and of the plan built from it; anything you add to the goal is still kept.
