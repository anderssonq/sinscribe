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
sinscribe pr         [--template <name>] [--base <ref>] [--ticket <id>] [--staged] [--out <file>]
sinscribe prompt     [description...] [--type feature|bugfix] [--handoff] [--out <file>]
sinscribe commit     [--all] [--scope <s>] [--no-gitmoji]
sinscribe branch     <ticket-or-description...> [--type feat|fix|chore|...]
sinscribe context    [--out <file>] [--format md|json]
sinscribe docs       [--out <file>]
sinscribe agents     [--target claude|agents|both] [--update]
sinscribe agent-setup
sinscribe template   list | show <name> | add <name> [--from <file>] | edit <name> | path

Global flags (every command; may appear anywhere in the command line):
  -p, --print          one-shot, print result to stdout, exit (also selected
                       automatically whenever stdin is not a TTY)
  --dry-run            no LLM call, no credential read; deterministic scaffold output
  --model-id <id>      model override for this run
  --provider <name>    provider override for this run (not persisted)
  --api-key <key>      API key override for this run (not persisted)
  -v, --version        print the version
  -h, --help           help (global only; there is no per-command help)
```

### Per-command behavior

| Command       | LLM mode             | Input                                                  | Output                                                                                              |
| ------------- | -------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `pr`          | single-shot          | `git diff <base>...HEAD` + commits + branch + template | Filled PR/MR description (stdout or `--out`)                                                        |
| `prompt`      | single-shot          | branch/ticket context + your description               | Copy-ready feature/bugfix task prompt for an AI coding agent (stdout or `--out`)                    |
| `commit`      | single-shot          | `git diff --staged` (or `--all` = tracked worktree)    | Conventional Commit + Gitmoji message; errors cleanly if nothing staged                             |
| `branch`      | single-shot (tiny)   | ticket ID and/or free text                             | 3 suggested kebab-case branch names `type/TICKET-123-short-slug`                                    |
| `context`     | agentic (deepagents) | repo exploration via agent tools                       | Structured brief: stack, entrypoints, conventions, key modules, scripts                             |
| `docs`        | agentic (deepagents) | repo exploration                                       | Project documentation with mermaid diagrams (stdout, `--out`, or interactive export)                |
| `agents`      | agentic (deepagents) | repo exploration                                       | Creates/updates CLAUDE.md and/or AGENTS.md inferred from the project. `--update` = surgical refresh |
| `agent-setup` | agentic (deepagents) | repo exploration + interactive answers                 | Specialized agent definitions written to `.claude/agents` (two passes: plan, then write)            |
| `template`    | none                 | template library on disk                               | list/show/add/edit; no LLM ever                                                                     |

**Two-tier runner** (key architectural decision):

- `runSingleShot(prompt, {modelId, onEvent})` — one `model.invoke/stream` call, no
  checkpointer, no shell backend. Used by `pr`, `commit`, `branch`, `prompt`. Fast,
  cheap, deterministic context (we compute the diff, the model never touches the repo).
- `runAgent(task, cwd, options)` — the deepagents loop (LocalShellBackend with
  `inheritEnv: false` plus an explicit `env: buildShellEnv()` — the caller's real
  environment minus every key in `SECRET_ENV_KEYS`, so the shell keeps PATH/HOME/
  SSH/git config but no API key; in-process MemorySaver checkpointer, so
  conversation state lives only for the CLI process's lifetime; streamed
  RunEvents). Used by `context`, `docs`, `agents`, `agent-setup`, and bare
  interactive mode.

The tier is chosen inside each domain module, not by a central predicate;
`isAgenticCommand` in `domain/execute.ts` is a UI predicate that only decides
whether tool activity is rendered live.

Both emit the same `RunEvent` union so the Ink UI and print mode are shared.

### `--dry-run` per command (no LLM, no credentials)

- `pr`: prints detected branch, ticket, base ref, diff stats (files/±lines), chosen
  template with placeholders left as `{{...}}`.
- `prompt`: detected branch/ticket plus the task type and description that would be sent.
- `commit`: staged file list + template skeleton `<gitmoji> type(scope): <subject>`.
- `branch`: pure-deterministic suggestion (slugified input — this command barely needs
  an LLM anyway; dry-run output is already usable).
- `context` / `docs` / `agents` / `agent-setup`: execution plan panel (what would be
  scanned/written).
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
├── package.json / tsconfig.json / eslint.config.js / .prettierignore
├── templates/                  # shipped defaults: andersoftware, github, google,
│                               #   kubernetes, shopify, stripe (.md)
├── src/
│   ├── cli.tsx                 # entry: parse → dry-run/offline/print | renders ui/ apps
│   ├── commands.ts             # argv → CliCommand union, helpContent (rebuilt grammar)
│   ├── constants.ts            # provider registry (opencode-go default, plus
│   │                           #   openrouter/baseten/fireworks/openai/
│   │                           #   openai-compatible/anthropic/kiro-cli),
│   │                           #   SINSCRIBE_* env keys, SECRET_ENV_KEYS
│   ├── env.ts                  # ~/.sinscribe/.env (renamed env keys)
│   ├── credentials.tsx         # first-run wizard
│   ├── ui/                     # Ink layer (apps + flows + pieces):
│   │   ├── run-app.tsx  menu-app.tsx  chat-app.tsx   # the three apps
│   │   ├── pr-review.tsx  prompt-review.tsx  docs-review.tsx
│   │   │   handoff-review.tsx  agent-setup.tsx       # review/refine flows
│   │   ├── run-view.tsx  menu-view.tsx  menu-items.ts # RunLog / pickers / prompts
│   │   ├── theme.ts  term.ts  viewport.ts  no-color.ts # terminal control
│   │   ├── text-buffer.ts  editor.ts  use-text-input.ts
│   │   │   mouse.tsx  mouse-protocol.ts              # input layer
│   │   └── shared.ts                                 # debug flag + error-text helpers
│   ├── llm/
│   │   ├── model.ts            # resolveModel(): credentials + model construction
│   │   ├── single-shot.ts      # runSingleShot(): stream + JSON extraction
│   │   ├── agent.ts            # runAgent(): deepagents loop, buildShellEnv()
│   │   ├── errors.ts           # classify / retry / friendly messages
│   │   ├── watchdog.ts         # inactivity + overall-deadline abort
│   │   ├── healthcheck.ts      # provider "Test connection"
│   │   ├── events.ts           # RunEvent types + callbacks
│   │   └── kiro-cli/           # ChatKiroCli subprocess model + tools:[] agent
│   ├── git/
│   │   ├── run.ts              # runGit() never-throw wrapper
│   │   ├── repo.ts             # isGitRepo, currentBranch, defaultBaseRef, remotes
│   │   ├── diff.ts             # stagedDiff, rangeDiff(base), diffStats, size capping
│   │   └── ticket.ts           # ticket-ID parsing from branch / input
│   ├── templates/
│   │   ├── schema.ts           # frontmatter parse + placeholder typing + validation
│   │   ├── registry.ts         # 3-tier discovery/override, list/resolve
│   │   └── render.ts           # substitution (git-filled + llm-filled slots)
│   ├── session/                # per-branch <repo>/.sinscribe/sessions/<branch>.json
│   ├── util/                   # clipboard
│   └── domain/                 # one module per command (prompt building + orchestration)
│       ├── pr.ts  prompt.ts  commit.ts  branch.ts  context.ts  docs.ts
│       │   agents.ts  agent-setup.ts  handoff.ts  template.ts
│       ├── execute.ts          # dispatch + isAgenticCommand/isOfflineCommand
│       ├── branch-actions.ts   # the only git writes (checkout -b / branch -m)
│       ├── rules.ts            # additive user + project rule tiers
│       ├── *-export.ts         # PR_DESCRIPTION / AGENT_PROMPT / HANDOFF / docs
│       ├── errors.ts           # CliError
│       └── prompts.ts          # system/user prompt builders
└── test/                       # vitest: one file per module (42 files)
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

- Providers: `opencode-go` (**default**, Kimi K2.7 Code default model) and
  `kiro-cli` are the **recommended** providers — supported and regularly
  tested. The rest — `openrouter`, `baseten`, `fireworks`, `openai`,
  `openai-compatible`, `anthropic` — stay selectable but are not actively
  maintained or regularly tested.
  Shared `PROVIDER_CONFIGS` shape, base-URL override env keys, OpenRouter fallback route.
- `ProviderConfig` is a discriminated union on `authKind`: `"api-key"`
  (everything but kiro-cli) vs `"local-cli"` (kiro-cli).
- **Application gating, and why `local-cli` exists** (learned the hard way,
  2026-07-16): AWS restricts a Q Developer subscription to **approved
  applications**, enforced at request time — a self-registered third-party
  client gets `AccessDeniedException: "Your subscription does not support
this application"` even with a perfectly correct request and a valid token.
  The ways past it are (a) impersonate an approved client, (b) have an
  Identity Center admin authorize the app (`entitledApplicationArn`), or
  (c) let an approved client make the call. We chose (c). (a) was rejected as
  misrepresentation whose ToS risk would land on the user's own account.
  An earlier direct implementation (SSO device flow + the unofficial
  `generateAssistantResponse` API + an AWS event-stream parser) was deleted
  once (c) was proven working: it could not serve anyone behind the gate, and
  removing it also removed this project's biggest risk — depending on a
  reverse-engineered wire format. The shapes are AWS's problem now.
- **`kiro-cli` provider** (`src/llm/kiro-cli/`): spawns AWS's official Kiro
  CLI (the renamed Amazon Q Developer CLI) — `kiro-cli chat --no-interactive
--agent sinscribe`, prompt over **stdin** (so a 50k diff can't hit the argv
  limit), stdout streamed. `local-cli` providers store **no credential**:
  `needsCredentialSetup` returns false, the settings wizard skips from the
  model pick straight to saving, and the healthcheck explains there is no key
  to test.
- **How tools are disabled — and why the obvious flag doesn't do it.**
  `--trust-tools=` governs _auto-approval_, not availability: verified
  against kiro-cli 2.3.0, a chat run with `--trust-tools=` still read a
  directory on disk. The agent config's `tools` field governs availability
  ("lists all tools that the agent can potentially use" — AWS's
  agent-format docs), so `agent.ts` writes a `tools: []` agent and passes
  `--agent`; the same probe then answers "I don't have access to a
  file-reading or directory-listing tool in this session". That empty
  allowlist is the single thing keeping this provider inside non-negotiable 1.
  Two sharp edges guard it: an **unknown key** in the config (a `$schema`
  line, say) makes Kiro skip the file _silently_, and a `--agent` it cannot
  load **falls back to a built-in agent that has tools** — so the config
  shape is exact, is rewritten before every run, and the runner treats
  "agent not found" on stderr as fatal rather than degrading quietly.
  The config lives under `~/.sinscribe/kiro-agent/` (which is also the
  child's cwd, so discovery is deterministic) and never touches the user's
  own agents in `~/.kiro/agents`.
- **Output cleaning** (`kiro-cli/output.ts`): `kiro-cli chat` is a TUI, not a
  text API — it emits ANSI styling and a `> ` answer marker even under
  `NO_COLOR=1`. The cleaner strips both, incrementally: buffering the whole
  answer would starve the inactivity watchdog on a long generation, so it
  holds back only a partial escape straddling a chunk boundary. Credits and
  warnings go to stderr and never reach the caller.
- Env keys: `SINSCRIBE_PROVIDER`, `SINSCRIBE_MODEL_ID`, `OPENCODE_API_KEY`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `OPENAI_COMPATIBLE_API_KEY/_BASE_URL`, `ANTHROPIC_BASE_URL`.
- Secrets: `~/.sinscribe/.env` (0700 dir / 0600 file), process.env precedence,
  redacted diagnostics — env.ts with a renamed key list.
- The TUI's AI settings wizard offers a **Test connection** step: a free
  `GET /models` against the provider (Bearer auth for the OpenAI-compatible
  family, `x-api-key` for Anthropic) that validates the key before saving.
  `local-cli` providers have no key, so that step is skipped.
- **Hang-proofing (2026-07-16)**: every streamed model call carries an
  inactivity watchdog (`src/llm/watchdog.ts`) — an AbortSignal threaded
  through LangChain's RunnableConfig plus a `raceAbort` wrapper so even a
  provider that ignores the signal cannot suspend the loop (120 s inactivity;
  10-minute overall cap on single-shot). Timeouts classify as retryable
  network errors. `cli.tsx` installs global `unhandledRejection`/
  `uncaughtException` guards and force-exits after a stdout/stderr flush, so
  lingering SDK sockets cannot keep the process alive; git subprocesses get a
  30 s timeout + `GIT_TERMINAL_PROMPT=0`.
- **Viewport/branding centralization (2026-07-16)**: terminal-size math lives
  in `src/ui/viewport.ts` (`useViewport` → `contentRows`, replacing three
  divergent chrome constants), brand assets in `src/ui/branding.ts`, the
  shared bordered frame in `src/ui/panel.tsx` (`Panel`/`TailPanel`), and the
  review flows' duplicated helpers in `src/ui/review-shared.ts`. The fixed
  16-line review clamps are height-aware, `RunLog`/chat history are
  tail-windowed, and the main menu windows its items — no view exceeds the
  terminal at extreme sizes (tested in `test/ui-render.test.ts`).
- **Bounded prompt rows (2026-07-30)**: a frame can outgrow the terminal
  because of its **content**, not just the window size — the previous pass only
  addressed the latter. Ink stops diffing at `outputHeight >= stdout.rows` and
  writes `clearTerminal + output` per render, synchronously to the TTY, so a
  pasted block in a prompt read as a freeze. Text prompts now render only the
  visual rows that fit, windowed around the caret (`wrapRows` /
  `visibleRowWindow` / `visibleSlice` in `src/ui/text-buffer.ts`), which makes
  their height independent of the text they hold; `useTextInput`
  (`src/ui/use-text-input.ts`) coalesces the many stdin reads of one paste into
  a single insert. With height bounded, the box size comes from the viewport
  (`computePromptRows`) instead of a fixed six lines. `TailPanel`, the streamed
  run log in direct/docs runs, the saved session context and long tool lines
  were the other content-driven overflows and are windowed the same way.

## 6. Open decisions (defaults chosen, flag if you disagree)

1. **Default provider = opencode-go, default model = Kimi K2.7 Code** (changed
   2026-07-08 from the original openrouter/GLM choice; the CLI still targets
   cheap models first). The full provider set is kept selectable
   (openrouter / baseten / fireworks / openai / openai-compatible / anthropic),
   but only opencode-go and kiro-cli are recommended — supported and regularly
   tested; the rest are not actively maintained.
2. **`branch` uses the LLM only when input is a description**; pure ticket ID input is
   handled deterministically.
3. **Interactive mode kept** (bare `sinscribe` opens the Ink chat/agent); the
   subcommands are the primary UX.
4. **deepagents dependency kept** for `context`/`docs`/`agents`/`agent-setup`/`chat`;
   `pr`/`commit`/`branch`/`prompt` bypass it entirely.
