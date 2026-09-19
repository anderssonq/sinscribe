---
"sinscribe": patch
---

📝 Compact the documentation and harden the private-files boundary.

`.gitignore` is now **deny-by-default for `.claude/`**. Three gaps closed:
`.claude/settings.local.json` was excluded only by a developer's _global_
gitignore, so a fresh clone or CI would have tracked it; `.claude/rules/`,
`.claude/agents/` and `.claude/commands/` were not excluded at all; and
`HANDOFF.md` — which `sinscribe prompt` writes at the repository root and
deliberately never self-ignores — was trackable in a public repo. The
root-anchored `/ARCHITECTURE.md` entry is unchanged, and `docs/ARCHITECTURE.md`
is verified still tracked. `docs/CONTRIBUTING.md` gains the matching house rule:
run `git check-ignore -v <path>` before adding a doc or dotfile.

The documentation drops from 1,633 to 1,292 lines with no information removed,
by deleting restatement rather than content. `docs/testing/COVERAGE-PLAN.md` was
a session report rather than documentation — it is gone, but its two durable
testing conventions (mock only at true I/O boundaries; redirect `homedir()` in
any test touching `~/.sinscribe`) moved into `docs/CONTRIBUTING.md`. `DESIGN.md`
is now decisions-only: its command surface, template schema and folder tree were
duplicates of `README.md` and `docs/ARCHITECTURE.md` and now link to them.
`docs/ARCHITECTURE.md`'s "Extension points" pointed at the same three recipes
`docs/CONTRIBUTING.md` already carried in a better form, so it now points there
and keeps only the shape those procedures assume.

Three stale facts are corrected against `src/`: base-ref resolution also probes
`origin/develop` and `develop` (`src/git/repo.ts`); the diff marker is
`[diff truncated to N bytes]`, not `[truncated: N more files]` (`src/git/diff.ts`);
and the README's status note read "Stable (v1.0.0)" while the package was at
1.4.1. `CHANGELOG.md` loses a clause that advertised the existence and location
of untracked local notes, and three bullets that began with `#` — the exact
defect `docs/CONTRIBUTING.md` warns about — are fixed.
