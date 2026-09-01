# Contributing to Sinscribe

Thanks for taking the time. This document covers local setup, the checks your
change has to pass, the conventions the codebase follows, and how releases work.

For how the system fits together, read [`ARCHITECTURE.md`](./ARCHITECTURE.md).
For design rationale and open decisions, read [`../DESIGN.md`](../DESIGN.md).

## Setup

Requires **Node ≥ 20** and **git**. The repository pins **pnpm 10.30.0** via
`packageManager`, so use pnpm rather than npm.

```bash
pnpm install
pnpm build                 # tsc → dist/
pnpm dev pr --dry-run      # run from source via tsx
```

No API key is needed for `--dry-run` or for any `template` subcommand, which is
usually enough to develop against.

> `pnpm dev` takes command arguments directly — **no `--` separator**.
> `pnpm dev -- pr` fails with `Unknown option: --`.

Useful variants:

| Command                         | What it does                                    |
| ------------------------------- | ----------------------------------------------- |
| `pnpm dev <cmd>`                | Run from `src/` through tsx                     |
| `pnpm dev-watch <cmd>`          | Same, restarting on file change                 |
| `pnpm start` / `pnpm sinscribe` | Run the built `dist/cli.js`                     |
| `pnpm link --global`            | Put `sinscribe` on your PATH from this checkout |

## Before you push — the gates

Four checks. CI (`.github/workflows/ci.yml`) runs exactly these, in this order,
on Node 20 and Node 22, for every push to `main` and every pull request.

```bash
pnpm build                 # must compile clean
pnpm test                  # vitest
pnpm lint:check            # eslint      (pnpm lint   = --fix)
pnpm format:check          # prettier    (pnpm format = --write)
```

`pnpm format:check` covers Markdown too, so a documentation-only change can fail
it. `pnpm format` fixes that.

## Where things live

```
src/cli.tsx          entry: main() routing, process guards, the three Ink roots
src/commands.ts      argv → CliCommand union; help text. Pure, no I/O
src/constants.ts     provider registry, env-var names, SECRET_ENV_KEYS
src/env.ts           ~/.sinscribe paths, .env load/save, credential diagnostics
src/credentials.tsx  first-run key wizard
src/domain/          one module per command, + execute.ts dispatch + prompts.ts
src/git/             runGit/tryGit, repo detection, diffs, ticket parsing
src/llm/             the two-tier runner: single-shot.ts vs agent.ts
  llm/kiro-cli/      ChatKiroCli — the kiro-cli binary as a chat model
src/templates/       schema · registry (3-tier override) · render
src/session/         per-branch <repo>/.sinscribe/sessions/<branch>.json
src/ui/              Ink apps (run/menu/chat), review flows, shared views,
                     theme/terminal/input infrastructure
src/util/            clipboard
templates/           the six shipped PR templates (builtin tier)
test/                vitest
```

## Testing

Vitest, run with `pnpm test` (single pass; there is no watch script). There is no
`vitest.config.*` — it runs on defaults and picks up `test/**/*.test.ts`.

- `test/git-fixture.ts` builds throwaway repositories under `mkdtemp` for the git
  plumbing tests. Use it rather than mocking git.
- `test/tsconfig.json` extends the root config and is what feeds eslint's
  `projectService` for type-checked linting of test files. `pnpm build` does not
  compile `test/`.
- Add a test file per module you touch, matching the existing naming
  (`src/git/diff.ts` → `test/diff.test.ts`).

**The golden-inventory tripwire.** `test/templates.test.ts` asserts the exact list
of shipped template files, that each parses as `kind: pr` with at least one LLM
slot, and that `andersoftware` exposes a specific set of required and optional
slots. Adding or removing anything in `templates/` fails it deliberately —
update the assertion in the same commit, so the shipped set is never changed by
accident.

**Not covered today:** the network path of `src/llm/model.ts`, and the Ink roots
end to end. Exercise those by hand with `pnpm dev <cmd>` and `--dry-run`.

## Recipes

### Add a subcommand

1. Extend `SUBCOMMANDS` and the `CommandSpec` union in `src/commands.ts`.
2. Add a `parseX(args)` function and a case in `parseSubcommand`.
3. Add it to `getHelpText()`.
4. Create `src/domain/<x>.ts` exporting `runX(spec, flags, cwd, callbacks)` and
   `dryRunX(spec, cwd)`.
5. Wire cases into both `executeCommand` and `executeDryRun`. Both switches are
   exhaustive over `CommandSpec["name"]`, so TypeScript will flag a missing arm.
6. Classify it: `isAgenticCommand` only if it streams tool activity worth
   rendering, `isOfflineCommand` only if it needs neither model nor credentials.
7. Add a system prompt in `domain/prompts.ts` if it is LLM-backed.
8. Add tests — at minimum, parser coverage in `test/commands.test.ts`.

### Add a provider or model preset

1. Add the literal to `SinscribeProvider` and the API-key constant in
   `src/constants.ts`; add the constant to `SECRET_ENV_KEYS` if it is a secret.
2. Add a `PROVIDER_CONFIGS` entry. The first `modelOptions` entry becomes that
   provider's default model.
3. Add it to `SELECTABLE_PROVIDERS` so it appears in the settings picker.
4. Add the env keys to `managedEnvKeys` in `src/env.ts`, and to
   `getCredentialDiagnostics()` if they should be visible in diagnostics.
5. Only touch `createModel()` in `src/llm/model.ts` if the SDK class differs — an
   OpenAI-compatible provider needs no code there, since `createModel` falls
   through to `ChatOpenAI` with a base URL.

### Add a template

Drop a `.md` in `templates/` with valid frontmatter (`name`, `kind`,
`placeholders`). Every `{{slot}}` needs a frontmatter entry, and every
`from: llm` slot should carry a `description` — it goes into the prompt as the
instruction for that slot. Verify with:

```bash
pnpm dev template show <name>
pnpm dev pr --template <name> --dry-run
```

Then update the golden inventory in `test/templates.test.ts`.

### Tune output quality

Edit the builder in `src/domain/prompts.ts`. Keep the `JSON_ONLY_INSTRUCTION`
contract for single-shot commands, and re-check that the reply still parses —
`pr` and `branch` will re-ask once on invalid JSON, which hides a regression
behind an extra model call.

## House rules

- **The two-tier runner is load-bearing.** Never give `pr`, `prompt`, `commit`, or
  `branch` tools, a shell, or a checkpointer. They stay single-shot and
  deterministic.
- **Never let secrets reach the agent's shell.** `LocalShellBackend` is built with
  `inheritEnv: false` and an explicit `env: buildShellEnv()`, which strips every
  key in `SECRET_ENV_KEYS`. Do not switch it to `inheritEnv: true`, and do not
  pass a bare environment either — that breaks `PATH` outside macOS.
- **`--dry-run` and `template` touch no credentials and no network.** Both run
  before `loadSinscribeEnv()` in `main()`. Keep it that way.
- **Errors:** throw `CliError` for expected, user-facing failures — clean message,
  exit 1, no stack. Anything else is treated as a bug.
- **Git only through `runGit`/`tryGit`/`runGitStrict`** (`src/git/run.ts`). Never
  call `execFile` for git anywhere else; the bounds and `GIT_TERMINAL_PROMPT=0`
  live in that module.
- **Validate before persisting** (templates on save and edit, sessions on load)
  and **bound inputs** (diffs are byte-capped, model IDs are validated).
- **Secrets never surface.** Only `~/.sinscribe/.env` (0600) and `process.env`;
  diagnostics stay redacted.
- Prefer **discriminated unions with exhaustive `switch`**, named exports, and
  alphabetised keys. Match the surrounding style.
- Comment the **why**, not the what. The existing comments are the model to
  follow: they explain the failure a piece of code prevents.

## Debugging

| Tool                                | Use                                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `sinscribe <cmd> --dry-run`         | Shows detected branch, ticket, base ref, diff stat, template, rules, and the rendered scaffold with no model call. The fastest wiring check. |
| `SINSCRIBE_DEBUG=1 sinscribe <cmd>` | Provider, model, and thread-ID lines on stderr.                                                                                              |
| `sinscribe template path`           | Prints all three template directories.                                                                                                       |
| `sinscribe -p "..."`                | One-shot non-interactive run; also what a non-TTY stdin selects.                                                                             |

## Commits and pull requests

This repository dogfoods its own conventions: **Conventional Commits + Gitmoji**,
for example `✨ feat(ui): keep the picker inside a narrow viewport`. Use
`sinscribe commit` and `sinscribe pr` to generate them.

Nothing enforces this mechanically — there is no commitlint and no husky hook —
so it is on you and on review.

Two things to watch for, both visible in the history:

- **Do not leave a `#` at the start of the subject.** Several older commits begin
  `# 🔒 fix(agent): ...` because a commented editor line leaked into the subject.
- Branch prefixes have drifted between `feat/` and `feature/`. Prefer `feat/`,
  matching the Conventional Commits type.

Pull requests merge as **merge commits**, not squashes. Keep them focused, and
update `docs/ARCHITECTURE.md` when you change how something works.

## Releases

Releases run on [changesets](https://github.com/changesets/changesets).

1. With your change, run `pnpm changeset` and describe it. Pick the semver bump:
   patch for fixes, minor for new commands, flags, or env vars, major for a
   breaking change to the CLI surface.
2. Merging to `main` triggers the `release` job, which opens or updates a
   **"Version Packages"** pull request applying every pending changeset to
   `package.json` and `CHANGELOG.md`.
3. Merging that pull request publishes to npm via `changeset publish`, using npm
   OIDC trusted publishing. There is no `NPM_TOKEN` — provenance comes from the
   workflow's OIDC identity.

The CLI surface — commands, flags, env vars, and config layout — is covered by
semver as of v1.0.0. A change to any of them needs a changeset that says so.
