---
name: google
kind: pr
description: Google-style minimal prose description optimized for git log
placeholders:
  subject:
    type: string
    required: true
    from: llm
    description: One-line summary, imperative mood, < 72 chars, standalone
  body:
    type: markdown
    required: true
    from: llm
    description: "Explain what and why, not how — the diff shows how. Wrap at ~72 chars"
  bug_footer:
    type: string
    required: false
    from: llm
    description: "A footer line like 'Bug: 123456' when a ticket is known from the business context or branch. Omit otherwise"
  test_footer:
    type: string
    required: false
    from: llm
    description: "A footer line like 'Test: ran unit tests, verified on staging' describing verification. Omit if unknown"
---

{{subject}}

{{body}}

{{bug_footer}}
{{test_footer}}
