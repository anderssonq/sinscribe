---
name: github
kind: pr
description: GitHub default pull request template
placeholders:
  description:
    type: markdown
    required: true
    from: llm
    description: Summary of the change and which issue is fixed
  fixes:
    type: string
    required: false
    from: llm
    description: "A line like 'Fixes #123' when an issue is known from the business context or branch. Omit otherwise"
  type_of_change:
    type: markdown
    required: true
    from: llm
    description: "The full checkbox list with matching boxes checked: - [x] Bug fix / - [ ] New feature / - [ ] Breaking change / - [ ] Docs update"
  testing:
    type: markdown
    required: true
    from: llm
    description: Describe the tests run to verify the change
---

## Description

{{description}}

{{fixes}}

## Type of change

{{type_of_change}}

## How Has This Been Tested?

{{testing}}

## Checklist:

- [ ] Self-reviewed code
- [ ] Commented hard-to-understand areas
- [ ] Updated documentation
- [ ] No new warnings
