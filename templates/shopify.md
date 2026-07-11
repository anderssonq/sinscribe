---
name: shopify
kind: pr
description: Shopify-style lean Problem / Solution / Result template
placeholders:
  problem:
    type: markdown
    required: true
    from: llm
    description: "What's broken or missing? Ground it in the business context when provided"
  solution:
    type: markdown
    required: true
    from: llm
    description: What this change does about the problem
  result:
    type: markdown
    required: true
    from: llm
    description: What the user or developer now experiences, and how it was verified
---

### Problem

{{problem}}

### Solution

{{solution}}

### Result

{{result}}
