# Contributing to Sinscribe

A quick-start for contributors. For the full architecture, read
[`documentation.md`](./documentation.md); for design rationale, `DESIGN.md`.

## Setup

```bash
pnpm install
pnpm build                 # tsc → dist/
pnpm dev pr --dry-run      # run from source (tsx). Note: NO "--" before args.
```

Requires **Node ≥ 20** and **git**. No API key is needed for `--dry-run` or
`template` commands.

## Before you push — the gates

Run all four locally; CI (`.github/workflows/ci.yml`) re-runs them on push/PR:

```bash
pnpm test                  # vitest
pnpm lint:check            # eslint  (pnpm lint = --fix)
pnpm format:check          # prettier (pnpm format = --write)
pnpm build                 # must compile clean
```

## Where things live

```
src/cli.tsx        entry: main() routing + no-Ink print path
src/commands.ts    argv → CliCommand union; help text
src/domain/        one module per command + execute.ts dispatcher + prompts.ts
src/llm/           the two-tier runner: single-shot.ts (pr/commit/branch) vs agent.ts
src/git/           runGit/tryGit, repo detection, diffs, ticket parsing
src/templates/     schema · registry (3-tier override) · render
src/session/       per-branch .sinscribe/sessions/<branch>.json
src/ui/            Ink apps (run-app / menu-app / chat-app) + pieces (run-view, menu-view)
templates/         shipped PR templates (builtin tier)
test/              vitest (deterministic units only)
```

## Common recipes

**Add a subcommand:** extend `CommandSpec` + `SUBCOMMANDS` and add a parser in
`commands.ts` → add `run<X>()`/`dryRun<X>()` in `domain/<x>.ts` → wire cases into
`execute.ts` (`executeCommand`, `executeDryRun`, and the `isAgenticCommand` /
`isOfflineCommand` classifiers) → add a system prompt in `prompts.ts` if LLM-backed
→ add tests.

**Add a provider / model preset:** edit `PROVIDER_CONFIGS` and env-key constants in
`constants.ts` → add the key to `managedEnvKeys` in `env.ts` → wire the model class
in `createModel()` (`llm/model.ts`) if it isn't OpenAI-compatible.

**Add a template:** drop a `.md` in `templates/` with valid frontmatter (`name`,
`kind`, `placeholders`). Every `{{slot}}` needs a frontmatter entry; give each
`from: llm` slot a `description` (it goes into the prompt). Verify with
`sinscribe template show <name>` and `sinscribe pr --template <name> --dry-run`.

**Tune output quality:** edit the builder in `domain/prompts.ts`. Keep the
`JSON_ONLY_INSTRUCTION` contract for single-shot commands and re-check that the JSON
still parses.

## House rules (don't regress these)

- **Two-tier runner is load-bearing.** Never give `pr`/`commit`/`branch` tools, a
  shell, or a checkpointer — they must stay single-shot and deterministic. Never
  remove `inheritEnv: true` from the agent's `LocalShellBackend`.
- **`--dry-run` and `template` touch no credentials and no network.** They run
  before `loadSinscribeEnv()` in `main()` — keep it that way.
- **Errors:** throw `CliError` for expected, user-facing failures (clean message,
  exit 1). Everything else is treated as a bug.
- **git only via `runGit`/`tryGit`** (`src/git/run.ts`) — never call `execFile`
  for git elsewhere.
- **Validate before persisting** (templates on save/edit, sessions on load) and
  **bound inputs** (diffs are size-capped; model ids are validated).
- **Secrets never surface** — only `~/.sinscribe/.env` (0600) / `process.env`;
  diagnostics stay redacted.
- Prefer **discriminated unions + exhaustive `switch`**, named exports, and
  alphabetized keys — match the surrounding style.

## Debugging

- `SINSCRIBE_DEBUG=1 sinscribe <cmd>` → provider/model/thread debug lines on stderr.
- `sinscribe <cmd> --dry-run` → shows detected branch/ticket/base/diff/template with
  no model call — the fastest wiring check.

## Commits & PRs

This repo dogfoods its own conventions: **Conventional Commits + Gitmoji**
(`✨ feat(scope): …`). Use `sinscribe commit` and `sinscribe pr` to generate them.
Keep PRs focused; update `documentation.md` when you change architecture.
