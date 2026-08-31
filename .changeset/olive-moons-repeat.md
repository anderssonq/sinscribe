---
"sinscribe": patch
---

📝 docs: rewrite the documentation against the code

The docs had drifted far enough to mislead. `documentation.md` described a
`src/` tree missing roughly twenty modules and claimed the LLM and Ink layers
were untested; `CONTRIBUTING.md` stated the agent-shell security invariant
backwards; `README.md` promised an enforcement the code does not implement.
Every claim in the three documents is now traced to a file in `src/`, and the
examples were executed rather than assumed.

**`README.md`** keeps its identity — logo, badges, screenshot, "Why I built
this", the openwiki credit — and gains a **Troubleshooting** section mapping
the CLI's real error strings to their causes, a **Project rules** section for
the two additive rule tiers, a complete environment-variable reference, and
`-v/--version` and `-h/--help` in the flag table. Two long-standing errors are
fixed: the `branch` example was annotated `# → fix/...` when it produces
`feat/...`, and the menu's context-first gate covers `prompt` as well as `pr`
and `branch`.

**`docs/ARCHITECTURE.md`** is new and replaces `documentation.md`: a module
map, the key abstractions and the problem each solves, both runners traced end
to end, the three layered-configuration systems and why they resolve in
different directions, extension points, and the design decisions with their
tradeoffs. It records the fact no previous doc stated — the single-shot/agentic
tier is chosen inside each domain module, and `isAgenticCommand` is a UI
predicate that only decides whether tool activity is rendered live.

**`docs/CONTRIBUTING.md`** moves from the repository root and now documents the
gates in CI's actual order, the golden-template tripwire, the real
zero-coverage areas, and the changesets release flow. Its house rule about the
agent's shell is corrected: `LocalShellBackend` uses `inheritEnv: false` with
an explicit scrubbed environment, not `inheritEnv: true`.

**`DESIGN.md`** keeps its role and gets factual corrections only — a
`.prettierrc` that does not exist, a stale provider set, a command surface
missing `agent-setup` and several flags, and the same `inheritEnv` error.

`.gitignore` now anchors its `ARCHITECTURE.md` entry to the repository root.
The bare pattern matched at every depth, so it would have silently swallowed
`docs/ARCHITECTURE.md`; the private openwiki recon notes at the root stay
ignored.
