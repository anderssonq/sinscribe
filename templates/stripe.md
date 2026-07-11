---
name: stripe
kind: pr
description: Stripe-style template with explicit risk and rollout thinking
placeholders:
  summary:
    type: markdown
    required: true
    from: llm
    description: What this PR does and why
  risk:
    type: markdown
    required: true
    from: llm
    description: "What could go wrong: blast radius, mitigations, rollback plan"
  rollout:
    type: markdown
    required: true
    from: llm
    description: "Deploy plan: feature flag, gradual rollout, monitoring/alerts to watch — or 'standard deploy' when trivial"
  testing:
    type: markdown
    required: true
    from: llm
    description: How this was verified
---

## Summary

{{summary}}

## Risk

{{risk}}

## Rollout

{{rollout}}

## Testing

{{testing}}
