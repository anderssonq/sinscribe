---
name: andersoftware
kind: pr
description: "House style: Conventional Commits + Gitmoji title with full review sections"
placeholders:
  branch: { type: string, required: true, from: git }
  title:
    type: string
    required: true
    from: llm
    description: "Full title line: <emoji> <type>(<scope>): <subject> — one gitmoji, Conventional Commits type, imperative lowercase subject, <= 72 chars total"
  summary:
    type: markdown
    required: true
    from: llm
    description: 2-4 sentences on what this PR does and why it matters
  changes:
    type: list
    required: true
    from: llm
    description: High-signal concrete changes in this diff
  motivation:
    type: markdown
    required: true
    from: llm
    description: The problem this solves; ground it in the business context when provided
  testing:
    type: markdown
    required: true
    from: llm
    description: How this was verified — unit tests, manual steps, edge cases
  screenshots_section:
    type: markdown
    required: false
    from: llm
    description: "ONLY for user-visible UI changes: a complete section starting with the heading '## Screenshots / Recordings' plus placeholder lines to fill in. Omit entirely otherwise"
  breaking_section:
    type: markdown
    required: false
    from: llm
    description: "ONLY when there are breaking changes: a complete section starting with the heading '## Breaking Changes' listing them with migration notes. Omit when none"
  related_section:
    type: markdown
    required: false
    from: llm
    description: "A complete section starting with the heading '## Related' with lines like 'Closes #X' or 'Refs TICKET-123' from the business context or branch. Omit when nothing to link"
---

# {{title}}

> Branch: `{{branch}}`

## Summary

{{summary}}

## Changes

{{changes}}

## Motivation & Context

{{motivation}}

## Testing

{{testing}}

{{screenshots_section}}

{{breaking_section}}

{{related_section}}

## Checklist

- [ ] Tests added or updated
- [ ] Docs updated
- [ ] Self-reviewed the diff
- [ ] No secrets or debug logs left behind
