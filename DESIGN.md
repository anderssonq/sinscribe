# Sinscribe — Design

Git-centric developer-workflow assistant CLI. Inspired by openwiki's agentic-CLI
skeleton; the git-workflow domain, templates, and per-branch sessions are
Sinscribe's own.
Binary name: `sinscribe` (package `sinscribe`). Config home: `~/.sinscribe/.env`.

## 1. Command surface

Subcommands are positional (rather than mode flags) because there are several of
them; the flag-parsing style (hand-rolled loop → discriminated union) is kept.

```
sinscribe                                   # interactive chat/agent mode
sinscribe pr        [--template <name>] [--base <ref>] [--ticket <id>] [--out <file>]
sinscribe prompt    <feature-or-bug description...> [--type feat|bugfix]
sinscribe commit    [--all] [--scope <s>] [--no-gitmoji]
sinscribe branch    <ticket-or-description...> [--type feat|fix|chore|...]
sinscribe context   [--out <file>] [--format md|json]
sinscribe docs      [--out <file>]
sinscribe agents    [--target claude|agents|both] [--update]
sinscribe template  list | show <name> | add <name> [--from <file>] | edit <name> | path

Global flags (every command):
  -p, --print          one-shot, print result to stdout, exit (default for pr/commit/
                       branch/context when stdout is not a TTY)
  --dry-run            no LLM call, no credential read; deterministic scaffold output
  --model-id <id>      model override for this run
  -h, --help           help (global and per-command)
```

### Per-command behavior

| Command    | LLM mode             | Input                                                  | Output                                                                                              |
| ---------- | -------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `pr`       | single-shot          | `git diff <base>...HEAD` + commits + branch + template | Filled PR/MR description (stdout or `--out`)                                                        |
| `prompt`   | single-shot          | branch/ticket context + your description               | Copy-ready feature/bugfix task prompt for an AI coding agent (stdout or `--out`)                    |
| `commit`   | single-shot          | `git diff --staged` (or `--all` = tracked worktree)    | Conventional Commit + Gitmoji message; errors cleanly if nothing staged                             |
| `branch`   | single-shot (tiny)   | ticket ID and/or free text                             | 3 suggested kebab-case branch names `type/TICKET-123-short-slug`                                    |
| `context`  | agentic (deepagents) | repo exploration via agent tools                       | Structured brief: stack, entrypoints, conventions, key modules, scripts                             |
| `docs`     | agentic (deepagents) | repo exploration                                       | Project documentation with mermaid diagrams (stdout, `--out`, or interactive export)                |
| `agents`   | agentic (deepagents) | repo exploration                                       | Creates/updates CLAUDE.md and/or AGENTS.md inferred from the project. `--update` = surgical refresh |
| `template` | none                 | template library on disk                               | list/show/add/edit; no LLM ever                                                                     |

**Two-tier runner** (key architectural decision):

- `runSingleShot(prompt, {modelId, onEvent})` — one `model.invoke/stream` call, no
  checkpointer, no shell backend. Used by `pr`, `commit`, `branch`, `prompt`. Fast,
  cheap, deterministic context (we compute the diff, the model never touches the repo).
- `runAgent(task, cwd, options)` — the deepagents loop (LocalShellBackend
  with `inheritEnv: true`, in-process MemorySaver checkpointer — conversation
  state lives only for the CLI process's lifetime — streamed RunEvents). Used by
  `context`, `docs`, `agents`, and bare interactive mode.

Both emit the same `RunEvent` union so the Ink UI and print mode are shared.

### `--dry-run` per command (no LLM, no credentials)

- `pr`: prints detected branch, ticket, base ref, diff stats (files/±lines), chosen
  template with placeholders left as `{{...}}`.
- `prompt`: detected branch/ticket plus the task type and description that would be sent.
- `commit`: staged file list + template skeleton `<gitmoji> type(scope): <subject>`.
- `branch`: pure-deterministic suggestion (slugified input — this command barely needs
  an LLM anyway; dry-run output is already usable).
- `context` / `docs` / `agents`: execution plan panel (what would be scanned/written).
- `template`: N/A (already offline); `--dry-run` for `add/edit` shows target path.

## 2. Template schema

Templates are Markdown files with YAML frontmatter and `{{placeholder}}` slots.

Locations (later wins / overrides by name):

1. Built-ins shipped in package: `templates/*.md` (andersoftware, github,
   google, kubernetes, shopify, stripe)
2. User global: `~/.sinscribe/templates/*.md`
3. Project-local: `<repo>/.sinscribe/templates/*.md`

```markdown
---
name: jira
kind: pr # pr | commit | branch  (which command may use it)
description: PR description linking a Jira ticket
placeholders:
  ticket: { type: string, required: true, from: branch } # auto-detected
  title: { type: string, required: true, from: llm }
  summary: { type: markdown, required: true, from: llm }
  changes: { type: list, required: true, from: llm }
  test_plan: { type: markdown, required: false, from: llm }
  branch: { type: string, required: true, from: git }
---

## [{{ticket}}] {{title}}

### Summary

{{summary}}

### Changes

{{changes}}

### Test plan

{{test_plan}}
```

- `from: git|branch` placeholders are filled deterministically by the git layer
  (also in `--dry-run`); `from: llm` slots are what the model is asked to produce
  (as JSON matching the placeholder names, validated, then substituted).
- Typed placeholders: `string` (single line), `markdown` (block), `list` (rendered as
  `- item` bullets). Unknown/missing required → clear error, not silent blanks.
- `template add <name>` scaffolds frontmatter; `template edit` opens `$EDITOR`.

## 3. Folder structure

```
sinscribe/
├── package.json / tsconfig.json / eslint.config.js / .prettierrc
├── templates/                  # shipped defaults: andersoftware, github, google,
│                               #   kubernetes, shopify, stripe (.md)
├── src/
│   ├── cli.tsx                 # entry: parse → dry-run/offline/print | renders ui/ apps
│   ├── commands.ts             # argv → CliCommand union, helpContent (rebuilt grammar)
│   ├── constants.ts            # provider registry (anthropic/openai/openrouter/
│   │                           #   openai-compatible), SINSCRIBE_* env keys
│   ├── env.ts                  # ~/.sinscribe/.env (renamed env keys)
│   ├── credentials.tsx         # first-run wizard
│   ├── ui/                     # Ink layer (apps + pieces):
│   │   ├── run-app.tsx  menu-app.tsx  chat-app.tsx   # the three apps
│   │   ├── run-view.tsx  menu-view.tsx               # RunLog / pickers / prompts
│   │   └── shared.ts                                 # debug flag + error-text helpers
│   ├── llm/
│   │   ├── model.ts            # createModel(provider, modelId)
│   │   ├── single-shot.ts      # runSingleShot(): invoke + JSON extraction
│   │   ├── agent.ts            # runAgent(): deepagents loop
│   │   └── events.ts           # RunEvent types + parseStreamEvent
│   ├── git/
│   │   ├── run.ts              # runGit() never-throw wrapper
│   │   ├── repo.ts             # isGitRepo, currentBranch, defaultBaseRef, remotes
│   │   ├── diff.ts             # stagedDiff, rangeDiff(base), diffStats, size capping
│   │   └── ticket.ts           # ticket-ID parsing from branch / input
│   ├── templates/
│   │   ├── schema.ts           # frontmatter parse + placeholder typing + validation
│   │   ├── registry.ts         # 3-tier discovery/override, list/resolve
│   │   └── render.ts           # substitution (git-filled + llm-filled slots)
│   └── domain/                 # one module per command (prompt building + orchestration)
│       ├── pr.ts  prompt.ts  commit.ts  branch.ts  context.ts  docs.ts  agents.ts  template.ts
│       └── prompts.ts          # system/user prompt builders
└── test/                       # vitest: parser, ticket parsing, template render, env
```

## 4. Git-integration layer

- **Repo detection**: `git rev-parse --is-inside-work-tree`; every git-dependent command
  fails fast with `Not inside a git repository.` (exit 1) — including in `--dry-run`.
- **Staged diff** (`commit`): `git diff --staged --unified=3` + `--name-status`;
  empty → "Nothing staged. Stage changes with `git add` (or pass --all)."
- **PR diff** (`pr`): base ref resolution order: `--base` flag →
  `origin/HEAD` symbolic ref → `main`/`master` existence probe → error with hint.
  Diff = `git diff <base>...HEAD` plus `git log <base>..HEAD --oneline`.
- **Size capping**: diffs truncated per-file and overall (~50KB) with a
  `[truncated: N more files]` marker so prompts stay bounded (the agent's
  LocalShellBackend caps output similarly via maxOutputBytes).
- **Ticket parsing** (`ticket.ts`): regexes over branch name / user input:
  `[A-Z][A-Z0-9]+-\d+` (Jira), `#\d+` (GitHub), configurable via
  `SINSCRIBE_TICKET_PATTERN` env. Used by `pr` (auto), `branch` (input), `commit`
  (optional trailer `Refs: ABC-123`).
- **Branch naming** (`branch`): `type/TICKET-slug` — slug = lowercase kebab, ASCII,
  ≤ 40 chars; type from `--type` or inferred (fix/feat/chore keywords).

## 5. Providers / config

- Providers: `opencode-go` (**default and the only maintained provider**, Kimi
  K2.7 Code default model), plus `openrouter`, `baseten`, `fireworks`,
  `openai`, `openai-compatible`, `anthropic` — all in **beta** (selectable but
  not actively maintained or regularly tested).
  Shared `PROVIDER_CONFIGS` shape, base-URL override env keys, OpenRouter fallback route.
- Env keys: `SINSCRIBE_PROVIDER`, `SINSCRIBE_MODEL_ID`, `OPENCODE_API_KEY`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `OPENAI_COMPATIBLE_API_KEY/_BASE_URL`, `ANTHROPIC_BASE_URL`.
- Secrets: `~/.sinscribe/.env` (0700 dir / 0600 file), process.env precedence,
  redacted diagnostics — env.ts with a renamed key list.
- The TUI's AI settings wizard offers a **Test connection** step: a free
  `GET /models` against the provider (Bearer auth for the OpenAI-compatible
  family, `x-api-key` for Anthropic) that validates the key before saving.

## 6. Open decisions (defaults chosen, flag if you disagree)

1. **Default provider = opencode-go, default model = Kimi K2.7 Code** (changed
   2026-07-08 from the original openrouter/GLM choice; the CLI still targets
   cheap models first). The full provider set is kept selectable
   (openrouter / baseten / fireworks / openai / openai-compatible / anthropic)
   but only opencode-go is supported and maintained — the rest are beta.
2. **`branch` uses the LLM only when input is a description**; pure ticket ID input is
   handled deterministically.
3. **Interactive mode kept** (bare `sinscribe` opens the Ink chat/agent); the
   subcommands are the primary UX.
4. **deepagents dependency kept** for `context`/`docs`/`agents`; `pr`/`commit`/`branch`/`prompt`
   bypass it entirely.
