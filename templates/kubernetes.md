---
name: kubernetes
kind: pr
description: Kubernetes / CNCF-style template with bot labels and release note
placeholders:
  kind:
    type: string
    required: true
    from: llm
    description: "The /kind label line, e.g. '/kind bug' — one of bug, feature, cleanup, documentation, failing-test"
  what:
    type: markdown
    required: true
    from: llm
    description: What this PR does and why we need it
  fixes:
    type: string
    required: false
    from: llm
    description: "A line like 'Fixes #123' when an issue is known. Omit otherwise"
  reviewer_notes_section:
    type: markdown
    required: false
    from: llm
    description: "A complete block starting with '**Special notes for your reviewer**:' when there is something reviewers must know. Omit otherwise"
  release_note:
    type: markdown
    required: true
    from: llm
    description: "User-facing change note, or exactly 'NONE' when there is no user-facing change"
---

**What type of PR is this?**
{{kind}}

**What this PR does / why we need it**:

{{what}}

**Which issue(s) this PR fixes**:
{{fixes}}

{{reviewer_notes_section}}

**Does this PR introduce a user-facing change?**

```release-note
{{release_note}}
```
