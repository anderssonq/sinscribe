<div align="center">

<pre>
         oo                                     oo dP
                                                   88
.d8888b. dP 88d888b. .d8888b. .d8888b. 88d888b. dP 88d888b. .d8888b.
Y8ooooo. 88 88'  `88 Y8ooooo. 88'  `"" 88'  `88 88 88'  `88 88ooood8
      88 88 88    88       88 88.  ... 88       88 88.  .88 88.  ...
`88888P' dP dP    dP `88888P' `88888P' dP       dP 88Y8888' `88888P'
</pre>

**Your git workflow, written for you — from the terminal.**

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
[![npm](https://img.shields.io/npm/v/sinscribe.svg)](https://www.npmjs.com/package/sinscribe)
![Built with TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6.svg)

</div>

Sinscribe is a git-centric developer-workflow assistant CLI. It reads your
actual git state — diffs, branch, ticket, session context — and writes the
prose around it: PR/MR descriptions, commit messages, branch names,
project-context briefs, documentation with mermaid diagrams, and AI agent
context files (`CLAUDE.md` / `AGENTS.md`). It runs in your terminal as a
one-shot command or an interactive chat agent.

> [!NOTE]
> **Stable since v1.0.0.** Sinscribe is in daily use and its CLI surface —
> commands, flags, env vars, and config layout — is now covered by semver.
> Install it globally with `npm install -g sinscribe`, or
> [from source](#install) for development.

<p align="center">
  <img width="600" height="483" alt="sinscribe (1)" src="https://github.com/user-attachments/assets/f1604f79-ab7d-4623-a237-719384cd47ee" />
</p>

## Features

- **PR/MR descriptions** from your local changes vs the target branch, measured
  from the merge base up — so it works before you commit.
- **Conventional Commit + Gitmoji messages** from your staged changes.
- **Branch names** and **task prompts** for your AI coding agent, generated from
  a short description or ticket.
- **Project understanding** — a structured context brief, full documentation
  with mermaid diagrams, and `CLAUDE.md` / `AGENTS.md` scaffolding, produced by
  an agent that explores the repo.
- **Interactive chat** over the current repository.
- **Per-branch sessions** that capture business context (feature, ticket,
  requirements, target branch) and feed it to every generation — typed by
  hand, or drafted by the AI from your direction and the repo's code and docs,
  then reviewed and approved by you.
- **Customizable templates** — six built-in house styles plus your own, with
  typed placeholders filled deterministically from git or by the model.
- **Deterministic `--dry-run`** on every command: no model call, no credentials
  read — useful for previewing detection and in CI.

## Prerequisites

- Node.js >= 20
- git
- An API key for a supported provider (OpenCode Go by default — see
  [Configuration](#configuration)). The `kiro-cli` and `claude-cli` providers
  need no key.

## Install

```bash
npm install -g sinscribe
sinscribe --help
```

Or from source, for development:

```bash
pnpm install
pnpm build
node dist/cli.js --help       # or: pnpm sinscribe --help
# optional: pnpm link --global   → `sinscribe` on your PATH
```

## Quick start

The first command needs no API key, which makes it a good way to check that
Sinscribe reads your repository correctly before you configure anything:

```bash
cd your-repo
sinscribe pr --dry-run          # detected branch, base, ticket, diff + scaffold
```

Then set a key and generate for real:

```bash
export OPENCODE_API_KEY=...     # or run `sinscribe` and let it ask
sinscribe pr                    # draft a PR description from your local changes
sinscribe commit                # Conventional Commit message from staged changes
sinscribe                       # interactive menu + chat over the current repo
```

The first interactive run asks for your provider API key and stores it in
`~/.sinscribe/.env`.

## Commands

| Command                 | What it does                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- |
| `sinscribe`             | Interactive chat agent + menu over the current repo                             |
| `sinscribe pr`          | PR/MR description from local changes vs the target branch                       |
| `sinscribe commit`      | Conventional Commit + Gitmoji message from staged changes                       |
| `sinscribe branch`      | Branch-name suggestions from a description/ticket                               |
| `sinscribe prompt`      | Copy-ready feature/bugfix task prompt for your AI coding agent                  |
| `sinscribe plan`        | Spec plan (SDD): requirements → design → tasks → handoff, plus an agent loop    |
| `sinscribe recover`     | Take over a branch an automated pipeline could not finish, then fix or plan it  |
| `sinscribe context`     | Structured project-context brief (markdown or JSON)                             |
| `sinscribe docs`        | Project documentation with mermaid diagrams                                     |
| `sinscribe agents`      | Generate/refresh `CLAUDE.md` + `AGENTS.md` from the repo                        |
| `sinscribe agent-setup` | Analyze the project and write specialized agent definitions to `.claude/agents` |
| `sinscribe template`    | Manage the template library (`list` / `show` / `add` / `edit` / `path`)         |

### Command options

| Command       | Option                | Effect                                                                              |
| ------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `pr`          | `--template <name>`   | Template to use (default: `andersoftware`)                                          |
|               | `--base <ref>`        | Target branch to diff against (default: session, else detected)                     |
|               | `--staged`            | Diff only staged changes (default: all local changes)                               |
|               | `--ticket <id>`       | Ticket ID (default: parsed from the branch name)                                    |
|               | `--out <file>`        | Write the description to a file                                                     |
| `prompt`      | `--type <type>`       | `feature` or `bugfix` (default: inferred from the description)                      |
|               | `--out <file>`        | Write the prompt to a file                                                          |
|               | `--handoff`           | Also write `HANDOFF.md` without asking                                              |
| `plan`        | `--stage <stage>`     | `requirements`\|`design`\|`tasks`\|`handoff` (default: the next stage needing work) |
|               | `--feedback <text>`   | Revise the stage's current version with this feedback                               |
|               | `--no-explore`        | Never let the model read the repository (single-shot)                               |
|               | `--approve`           | Approve the stage's saved draft — offline, no model call                            |
|               | `--sync`              | Match `[T-n]` commits and checkboxes; refresh progress — offline                    |
|               | `--loop-prompt`       | Print `LOOP_PROMPT.md` (e.g. to pipe into a coding agent) — offline                 |
| `recover`     | `--worktree`          | Open the branch in `.worktrees/<ticket>` instead of checking it out here            |
|               | `--no-fetch`          | Resolve the branch from local refs only                                             |
|               | `--from <file>`       | The pipeline's failure notes (ticket comment, CI log) for the AI to start from      |
|               | `--save`              | Save the drafted context without review (the `-p/--print` route)                    |
| `commit`      | `--all`, `-a`         | Use all tracked changes, not only staged                                            |
|               | `--scope <scope>`     | Force the Conventional Commit scope                                                 |
|               | `--no-gitmoji`        | Skip the gitmoji prefix (it is on by default)                                       |
| `branch`      | `--type <type>`       | `feat`\|`fix`\|`chore`\|`docs`\|`refactor`\|`test`\|`perf`\|`build`\|`ci`\|`hotfix` |
| `context`     | `--out <file>`        | Write the brief to a file                                                           |
|               | `--format <md\|json>` | Output format (default: `md`)                                                       |
| `docs`        | `--out <file>`        | Write the documentation to a file                                                   |
| `agents`      | `--target <t>`        | `claude`\|`agents`\|`both` (default: `both`)                                        |
|               | `--update`            | Surgically refresh existing files                                                   |
| `agent-setup` | —                     | No options; the interactive flow asks what it needs                                 |
| `template`    | `add --from <file>`   | Seed a new user template from an existing file                                      |

`branch` takes a required ticket ID and/or description as positional arguments.
`prompt` takes an optional description; without one it falls back to the saved
session context. `recover` takes an optional branch name or ticket ID; without
one it recovers the current branch.

### Global options

Accepted by every command, and — because they are parsed in one pass over the
whole command line — they may appear anywhere in it.

| Flag                | Effect                                                             |
| ------------------- | ------------------------------------------------------------------ |
| `--dry-run`         | Deterministic scaffold: no LLM call, no credentials read           |
| `-p, --print`       | One-shot non-interactive run, result on stdout (default off a TTY) |
| `--model-id <id>`   | Model override for this run                                        |
| `--provider <name>` | Provider override for this run (not persisted)                     |
| `--api-key <key>`   | API key override for this run (not persisted)                      |
| `-v, --version`     | Print the version                                                  |
| `-h, --help`        | Show usage                                                         |

`-p/--print` is also selected automatically when stdin is not a TTY, so
`sinscribe` behaves correctly in a pipeline or a CI job.

### Examples

```bash
# Pull requests
sinscribe pr --template github --base origin/main --out PR.md
sinscribe pr --base develop --staged       # only staged changes, vs develop
sinscribe pr --dry-run                      # branch/ticket/diff detection + scaffold

# Commits & branches
sinscribe commit --scope api --no-gitmoji
sinscribe branch ABC-123 add retry logic to uploader   # → feat/ABC-123-... suggestions

# Prompts & project understanding
sinscribe prompt --type bugfix uploader crashes on empty files
sinscribe prompt --handoff -p "add retry logic"   # also writes HANDOFF.md
sinscribe plan                                     # spec plan, stage by stage, in the TUI
sinscribe plan -p --stage design --feedback "reuse the queue module"   # writes a draft
sinscribe plan --approve --stage design            # approve it (offline)
sinscribe plan --sync                              # progress from [T-n] commits + checkboxes
sinscribe recover ABC-123 --worktree --from failure.md   # take over a branch a pipeline gave up on
sinscribe context --format json --out context.json
sinscribe agents --target claude --update

# Templates
sinscribe template list
sinscribe template show andersoftware
sinscribe template path

# Chat & per-run overrides
sinscribe -p "what changed on this branch?"
sinscribe pr --provider anthropic --api-key sk-ant-...
```

Ticket IDs (`ABC-123`, `#42`) are auto-detected from the branch name for `pr`
and from the input for `branch`. When a branch session exists, its
feature/ticket/requirements are fed to the model as business context.

### Session handoff (`HANDOFF.md`)

A prompting session normally ends with the useful part — what was decided,
what is still open — only in your head. After you approve a prompt,
`sinscribe prompt` offers to write a **`HANDOFF.md`** at the repo root: a
snapshot of where the branch stands, not an accumulated log.

It is a fixed set of headings — where things stand, what was done, key
decisions, open questions, next steps, known issues — written empty for you to
fill, or filled by the model from the session.

The next `sinscribe prompt` on that branch reads the file back and feeds it to
the model, so a second iteration starts warm instead of re-deriving settled
ground. A handoff written on a different branch is still passed along, but
labeled as such rather than presented as the current state.

`--handoff` writes the file without asking — the only route in `-p/--print`
and other non-TTY runs, which cannot ask. The file is yours to commit or
ignore; Sinscribe never adds it to `.gitignore`.

### Spec plan (`sinscribe plan`)

Spec-driven development for the current branch, from its session context. Four
documents are generated and approved **in order** — each one is reviewed
(approve, modify with feedback, view full, save as draft) and the next is
generated from the approved ones:

| Stage | File              | Defines                                                                                          |
| ----- | ----------------- | ------------------------------------------------------------------------------------------------ |
| 1     | `requirements.md` | The what and why: `REQ-n` with testable `AC-n.m` criteria, assumptions, out of scope, boundaries |
| 2     | `design.md`       | The how: decisions with alternatives, data/DB changes, affected APIs, mermaid sequences, risks   |
| 3     | `tasks.md`        | Small verifiable tasks (`T-n`), each naming the ACs it implements and its exact verify command   |
| 4     | `handoff.md`      | The implementation's memory: status, decisions, spec deltas, blockers, and an append-only log    |

They live in `specs/<branch>/` with an `index.md` that links them and records
which stage is approved — **tracked in git on purpose**, so the plan travels
with the branch and a teammate can resume it (mind this in public repos). The
index is written only by Sinscribe; every stage file links to the others.

- **Grounded in the code.** Requirements and design let the model read the
  repository first, read-only: with the Claude Code provider through `claude`
  with only Read/Glob/Grep, confined to the repo (`--restricted`); with Kiro
  through an agent whose only tool is `fs_read`, limited to the repo; with
  API-key providers through a write-denied agent. `.env` files and keys are
  never readable, and output is scanned for secrets. `--no-explore` uses a
  single call with a repo brief (tracked files, scripts, `CLAUDE.md`/`AGENTS.md`).
- **Traceable.** Approving `tasks.md` is blocked while a task references an AC
  or task that does not exist, or the dependencies form a cycle; uncovered ACs,
  oversized tasks and missing verify commands are flagged.
- **Never silently stale.** Editing or regenerating a document marks everything
  after it stale until it is regenerated (or the edit is accepted). Ticking a
  task's checkbox is progress, not an edit.

**The implementation loop.** Approving the tasks writes `LOOP_PROMPT.md`: the
operating contract for your coding agent (Claude Code, Codex, …). The agent
takes one task at a time in dependency order, verifies it with its command,
ticks it, logs it in `handoff.md`, commits it with `[T-n]` in the subject
(unless your rules forbid commits), and stops at checkpoints, blockers, or
anything the spec does not decide — which it records as a _spec delta_ instead
of editing the spec. It finishes only when every task is checked and every AC
is verified. Hand it over with **Copy loop prompt** in the menu, or
`sinscribe plan --loop-prompt`. As work lands, **Sync progress**
(`--sync`) refreshes the status in `handoff.md` and `index.md` from the
checkboxes and commits, without touching the log; regenerating the handoff
feeds the agent's log back into it.

Sinscribe does not run the loop itself (yet): the agent you already use does.

### Recovering a failed branch (`sinscribe recover`)

When an automated pipeline (AI agents in CI) works on a branch and gives up —
its fix attempts ran out, tests stayed red — a developer takes over. `recover`
makes that a few keystrokes instead of an archaeology session:

1. **Open the branch.** `sinscribe recover ABC-123` fetches, finds the branch
   (an exact name, or every branch carrying the ticket — the one that _ends_
   with it wins, so `bot/ABC-123` beats `bot/ABC-123-design`), and checks it
   out. With uncommitted work here it refuses; `--worktree` opens it in
   `.worktrees/ABC-123` instead (kept out of `git status` through
   `.git/info/exclude`) and reuses that worktree next time. A branch that is
   only behind its remote is fast-forwarded; a diverged one is left alone and
   reported. Without a target, the current branch is recovered in place.
2. **Read what the pipeline left.** The AI drafts the branch's session context
   in _recovery mode_ — read-only, exactly like **Generate session context with
   AI**, but starting from the evidence: files whose path carries the ticket,
   the reports, specs, plans, logs and lock files the branch changed, its
   commits, and the diagnosis you pass with `--from` (the ticket comment or CI
   output, copied to a file). The draft names what the branch must deliver,
   lists one `Failure:` line per concrete failure and one `Remaining:` line per
   missing piece, and never proposes weakening the tests the pipeline was held
   to — a test or spec that looks wrong becomes an open question for you.
3. **Fix it.** Review and approve the context as usual, then pick **Quick fix —
   bugfix prompt** (one copy-ready prompt for your coding agent) or **Rework —
   spec plan** (requirements → design → tasks). Pushing the fix is yours — it
   is what re-triggers the pipeline.

Nothing in `recover` knows which pipeline produced the branch. Team-specific
rules — "never edit `tests/**` or `.locks/**`", "run `make test` before
pushing" — belong in your project rules (`.sinscribe/rules.md`), which every
step already follows. **Recover a failed branch** in the menu does the same for
the current branch; `sinscribe recover -p --save` drafts and saves without
review for scripts, so `sinscribe prompt --type bugfix -p` can follow it.

## Configuration

On first interactive run, Sinscribe asks for your provider API key and stores it
in `~/.sinscribe/.env` (directory `0700`, file `0600`). Real environment
variables always win over the file, and nothing secret is ever printed.

```bash
# ~/.sinscribe/.env (all optional; created by the CLI)
SINSCRIBE_PROVIDER="opencode-go"    # opencode-go | openrouter | baseten | fireworks | openai | openai-compatible | anthropic | kiro-cli | claude-cli
SINSCRIBE_MODEL_ID="kimi-k2.7-code" # default model for the provider
OPENCODE_API_KEY="..."
ANTHROPIC_API_KEY="..."             # if you switch to anthropic
                                    # (kiro-cli / claude-cli need no key — see below)
SINSCRIBE_TICKET_PATTERN="(T-\d+)"  # optional custom ticket regex
SINSCRIBE_THEME="ayu-dark"          # TUI color theme (set from the menu's Theme picker)
SINSCRIBE_REDUCED_MOTION="1"        # freeze the loading animation (the timer keeps counting)
```

### Environment variables

| Variable                     | Purpose                                                                        | Default                           |
| ---------------------------- | ------------------------------------------------------------------------------ | --------------------------------- |
| `SINSCRIBE_PROVIDER`         | Which provider to use                                                          | `opencode-go`                     |
| `SINSCRIBE_MODEL_ID`         | Model for `SINSCRIBE_PROVIDER` (a `--provider` override uses its own default)  | the provider's first listed model |
| `SINSCRIBE_TICKET_PATTERN`   | Custom ticket regex; the first capture group is used                           | `ABC-123`, then `#123`            |
| `SINSCRIBE_THEME`            | Persisted TUI color scheme                                                     | shipped default                   |
| `SINSCRIBE_REDUCED_MOTION`   | `1` or `true` renders a static spinner frame; the elapsed timer keeps counting | off                               |
| `SINSCRIBE_DEBUG`            | `1` prints provider/model/thread lines to stderr                               | off                               |
| `OPENCODE_API_KEY`           | Key for `opencode-go` — note the name has no `GO`                              | —                                 |
| `OPENROUTER_API_KEY`         | Key for `openrouter`                                                           | —                                 |
| `BASETEN_API_KEY`            | Key for `baseten`                                                              | —                                 |
| `FIREWORKS_API_KEY`          | Key for `fireworks`                                                            | —                                 |
| `OPENAI_API_KEY`             | Key for `openai`                                                               | —                                 |
| `ANTHROPIC_API_KEY`          | Key for `anthropic`                                                            | —                                 |
| `ANTHROPIC_BASE_URL`         | Base-URL override for `anthropic`                                              | SDK default                       |
| `OPENAI_COMPATIBLE_API_KEY`  | Key for `openai-compatible`                                                    | —                                 |
| `OPENAI_COMPATIBLE_BASE_URL` | **Required** for `openai-compatible` — it has no default                       | —                                 |
| `EDITOR` / `VISUAL`          | Editor opened by `template edit`                                               | `vi`                              |
| `NO_COLOR`                   | Disables color and the terminal background control                             | color on                          |

Resolution order for provider, model, and key: a per-run flag
(`--provider` / `--model-id` / `--api-key`), then the environment, then
`~/.sinscribe/.env`, then the built-in default. Per-run flags are never
persisted.

The default provider is **OpenCode Go** (an OpenAI-compatible endpoint at
`https://opencode.ai/zen/go/v1`) with **Kimi K2.7 Code** as the default model —
set `OPENCODE_API_KEY` and you're done. Other models on the same plan:
`glm-5.2`, `glm-5.1`, `kimi-k2.6`, `deepseek-v4-pro`, `deepseek-v4-flash`,
`mimo-v2.5`, `mimo-v2.5-pro`.

You can switch provider/model per run with `--provider` / `--model-id` /
`--api-key`, or persist a new choice from the TUI's **AI settings** item — which
also has a **Test connection** step that calls the provider's `GET /models`
endpoint (free, no tokens) to verify the key and model before saving.

### Provider support

| Provider                                                                         | Status                                                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `opencode-go`                                                                    | **Recommended** — the default; supported and regularly tested                                   |
| `kiro-cli`                                                                       | **Recommended** — drives AWS's official Kiro CLI; read-only explore for plan and session drafts |
| `claude-cli`                                                                     | Drives your signed-in Claude Code CLI; single-shot commands only                                |
| `openrouter`, `anthropic`, `openai`, `baseten`, `fireworks`, `openai-compatible` | Selectable — not actively maintained or regularly tested                                        |

> [!WARNING]
> Only the recommended providers (OpenCode Go and Kiro CLI) are exercised
> regularly. The others ship as-is and may lag behind their vendors' API
> changes — verify one with **Test connection** before relying on it.

Every provider except `kiro-cli` and `claude-cli` supports the full command
set. Those two are limited to `pr`, `commit`, `branch`, and `prompt`; see below.

OpenCode Go only routes clients that identify themselves, so every request
carries `User-Agent: sinscribe/<version>` and an `x-opencode-session` id — one
per run, and one per conversation in `chat` (see
[opencode.ai/docs/go](https://opencode.ai/docs/go/#where-can-i-use-it)).

### Amazon Q Developer setup (`kiro-cli`)

Use the Amazon Q subscription you already have, through AWS's own CLI:

1. Install **Kiro CLI** — `brew install kiro-cli`, or see
   [kiro.dev/docs/cli](https://kiro.dev/docs/cli/) — and run `kiro-cli login`
   once (IAM Identity Center, Builder ID, Google and GitHub all work).
2. Set `SINSCRIBE_PROVIDER=kiro-cli`, or pick **Amazon Q Developer (Kiro
   CLI)** in the TUI's **AI settings**. There is no key to enter and nothing
   is stored: `kiro-cli` owns its own sign-in.
3. Run `pr` / `commit` / `branch` / `prompt` as usual.

Pick a model with `--model-id` or in the settings wizard; the labels carry
each model's credit multiplier, e.g. `qwen3-coder-next` (0.05x) up to
`claude-sonnet-4.5` (1.30x). `auto` (the default) lets Kiro choose. For a model
the list doesn't have yet, choose **Custom model ID…** and type any id from
`kiro-cli chat --list-models`; it is passed straight through as `--model`.

**Why a subprocess and not the API?** AWS restricts Q subscriptions to
_approved applications_, so Sinscribe drives the official client rather than
impersonating one. The full reasoning is in [`DESIGN.md`](DESIGN.md).

**Tools are off, by construction.** Sinscribe runs `kiro-cli chat` with a
generated agent that declares `"tools": []`, so the model can write text but
has no tool to touch your working tree — that is what keeps `pr`/`commit`/
`branch`/`prompt` single-shot. (The `--trust-tools=` flag does _not_ do
this: it only governs auto-approval, and was verified to still let the model
read the filesystem.) The agent config lives under `~/.sinscribe/kiro-agent/`
and never touches your own Kiro agents.

**Limitation:** agentic commands (`context`/`docs`/`agents`/`agent-setup`/`chat`) need
tool calling and exit with a clear message asking you to switch providers.

### Claude Code setup (`claude-cli`)

Use your Claude subscription through the Claude Code CLI you already have:

1. Install **Claude Code** (see [code.claude.com/docs](https://code.claude.com/docs))
   and run `claude` once to sign in.
2. Set `SINSCRIBE_PROVIDER=claude-cli`, or pick **Claude Code (claude CLI)** in
   the TUI's **AI settings**. Nothing is stored: `claude` owns its own sign-in.
3. Run `pr` / `commit` / `branch` / `prompt` as usual.

Models are the CLI's own aliases: `sonnet` (the default), `haiku`, `opus`,
`fable` — pick one with `--model-id` or in the settings wizard. To pin an exact
model, choose **Custom model ID…** and type its full name (e.g.
`claude-opus-5-5`); anything `claude --model` accepts works.

Sinscribe runs `claude -p --output-format stream-json` with **no tools**
(`--tools ""`) and isolated from your setup — no settings, hooks, MCP servers
or skills (`--setting-sources ""`, `--strict-mcp-config`,
`--disable-slash-commands`), from a neutral directory
(`~/.sinscribe/claude-cli/`) so no repository `CLAUDE.md` applies. Sinscribe's
template replaces Claude Code's system prompt. API keys from
`~/.sinscribe/.env` are not passed to the child, so an `ANTHROPIC_API_KEY`
there never switches it from your login to pay-per-token billing. Agentic
commands are refused, as with `kiro-cli`.

### Reliability

- Every model call has a **120 s inactivity timeout** (and a 10-minute
  overall cap for single-shot commands); a stalled connection reports a
  clear network error — with automatic retries on the single-shot path —
  instead of freezing the CLI.
- **Ctrl+C always exits**, and the process force-exits after finishing its
  work, so a lingering SDK socket can never hang the terminal.
- git subprocesses are capped at 30 s with `GIT_TERMINAL_PROMPT=0`, so a
  credential or GPG prompt fails fast instead of blocking forever.

## Templates

Templates are Markdown files with YAML frontmatter and typed `{{placeholder}}`
slots. There are three tiers; a later tier overrides an earlier one by name:

1. **Built-in** (shipped): `andersoftware` (default — Conventional Commits +
   Gitmoji title with full review sections), `github`, `google`, `kubernetes`,
   `shopify`, `stripe`
2. **User**: `~/.sinscribe/templates/*.md`
3. **Project**: `<repo>/.sinscribe/templates/*.md`

```markdown
---
name: myteam
kind: pr
placeholders:
  ticket: { type: string, required: true, from: branch } # filled from git, deterministic
  summary: { type: markdown, required: true, from: llm } # produced by the model
  changes: { type: list, required: true, from: llm } # rendered as bullets
---

## [{{ticket}}] {{summary}}
```

`from: git|branch` slots are filled deterministically (also in `--dry-run`);
`from: llm` slots are requested from the model as validated JSON. Manage the
library with `sinscribe template list | show | add | edit | path`.

## Sessions

The menu (bare `sinscribe`) is **context-first**: on a branch with no saved
context it asks how to create one — generated with AI or written by hand — and
the "Create PR description", "Create branch name", "Create feature or bugfix
prompt" and "Spec plan (SDD)" items ask the same before they run (a spec plan already
in `specs/<branch>/` carries its own feature, so it opens without one). A session captures **business context** per
branch — feature description, ticket ID, requirements, and the **target branch**
it merges into — stored in `<repo>/.sinscribe/sessions/<branch>.json`.

### Generating the context with AI

**Generate session context with AI** (or **Regenerate**, once one exists)
drafts the context instead of you typing every field — but you steer it:

1. **Direction.** You say what the session is for and what it should achieve —
   one line is enough; paste ticket text, rules or the name of a report if you
   have them. Before you type, the screen shows what the AI will see: branch,
   detected ticket, commits, changed files, markdown docs, `HANDOFF.md`.
2. **Evidence.** The AI looks for code and markdown documents (reports, notes,
   specs, handoffs) related to your direction — **read-only**: with the Claude
   Code provider through `claude --restricted` with Read/Glob/Grep, with Kiro
   through an agent whose only tool is `fs_read` limited to the repository, with
   API-key providers through a write-denied agent. `.env` files and keys are
   never readable. You can also pick "Don't read the code" for a faster draft
   from git, the repo brief and excerpts of the matching docs.
3. **Review.** The draft shows the feature (your direction first), ticket,
   target, requirements, the **sources** it used and the **open questions** the
   repository could not answer. From there: **refine the goal**, **add details
   / answer questions**, **look again in the repository**, edit it by hand in
   the usual form, approve it, or cancel. Nothing is saved until you approve.

The approved context is a normal session: sources (and any open questions you
chose to keep) are appended to the requirements, so `pr`, `prompt`, `branch`
and `plan` use it like a typed one. The target branch is never the model's
choice, and a ticket is kept only when the branch name or the evidence
contains it.

### How sessions are used

- **`pr`** describes your local changes vs the target branch, from the merge
  base up — so it works before you commit, and commits that landed on the target
  after you branched don't pollute the diff. By default it includes all tracked
  changes (staged + unstaged); `--staged` narrows it to the index. On the next
  run for the same branch it enters **update mode**, revising the previous
  description with the fresh diff instead of starting over.
- The target branch is resolved in order: `--base <ref>`, then the session's
  saved target, then auto-detection (`origin/HEAD`, `origin/main`,
  `origin/master`, `origin/develop`, `main`, `master`, `develop`).
- **Create branch name** generates suggestions from the session context and
  creates the branch from the target (`git checkout -b <name> <target>`),
  migrating the session so `pr` works there immediately. Once the branch differs
  from its target, the item becomes **Rename branch** (`git branch -m`).

Session files live beside the project template tier, so `.sinscribe/.gitignore`
ignores only `sessions/` — `.sinscribe/templates/` and `.sinscribe/rules.md`
stay committable.

## Project rules

Free-text rules appended to every command's system prompt. Unlike templates,
the two tiers are **additive** — both apply, each labeled by origin:

- **Personal**: `~/.sinscribe/rules.md` — applies in every repository
- **Project**: `<repo>/.sinscribe/rules.md` — applies here, meant to be committed

Edit them from the menu's **Project rules** item. `--dry-run` reports which tiers
are active and how large they are, without sending them anywhere.

## Troubleshooting

| Message                                                                   | Cause and fix                                                                                                                                                    |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Not inside a git repository.`                                            | Every command except `template` needs a repo. `cd` into one.                                                                                                     |
| `Could not detect a target branch (tried origin/HEAD, origin/main, …)`    | No conventional default branch resolved. Pass `--base <ref>`, or save a target in the session context.                                                           |
| `No local changes vs <ref>. Nothing to describe.`                         | The branch matches its base. Commit or edit something, or check that `--base` points where you think.                                                            |
| `No staged changes vs <ref>.`                                             | You passed `--staged` with an empty index. `git add`, or drop the flag.                                                                                          |
| `Nothing staged. Stage changes with git add, or pass --all…`              | `commit` reads the index by default. Use `-a` for all tracked changes.                                                                                           |
| `<KEY> is required to run sinscribe with <Provider>.`                     | No API key for the selected provider. Set it in the environment, in `~/.sinscribe/.env`, or pass `--api-key`.                                                    |
| `Credentials are required for non-interactive runs.`                      | `-p/--print` and non-TTY runs cannot open the setup wizard. Set the key in the environment first.                                                                |
| `The <Provider> provider supports pr/commit/branch/prompt only for now…`  | You asked an agentic command of a provider without tool calling — today that means `kiro-cli` or `claude-cli`. Switch with `--provider` or `SINSCRIBE_PROVIDER`. |
| `Template not found: <name>. Available pr templates: …`                   | Typo, or the template is in a tier that is not being read. Check `sinscribe template path` and `sinscribe template list`.                                        |
| `Template <name> is a commit template, not a pr template.`                | A user or project template shadows a built-in of the same name with a different `kind`. Rename one of them.                                                      |
| `Template <name> requires a ticket ID, but none was found…`               | The template has a required `from: branch` slot. Pass `--ticket <id>` or rename the branch.                                                                      |
| `Model did not produce a commit subject.` / invalid JSON                  | The model broke format. `pr` and `branch` retry once automatically; otherwise re-run, or try another model with `--model-id`.                                    |
| `git … timed out after 30s — a credential or GPG prompt may be blocking.` | A git subprocess is waiting on hidden input. Unlock your key, or configure a non-interactive credential helper.                                                  |
| `Model call timed out — …`                                                | No output for 120 s, or 10 minutes total on a single-shot command. Usually a stalled connection; the single-shot path retries on its own.                        |
| `Unknown option for <cmd>: <flag>` (or `Unknown option: <flag>`)          | The flag is not accepted there. `sinscribe --help` lists every command's options; note there is no per-command help.                                             |

Two tools worth reaching for first:

```bash
sinscribe <cmd> --dry-run        # what was detected, with no model call
SINSCRIBE_DEBUG=1 sinscribe <cmd>  # provider, model, and thread on stderr
```

## How it works

- **`pr` / `commit` / `branch` / `prompt` are single-shot:** the CLI computes the
  diff and context locally and makes one model call — the model never touches
  your repo. (Branch creation/rename is a plain git call the CLI makes after you
  pick a name; the model only suggests names.)
- **`context` / `docs` / `agents` / `agent-setup` / chat are agentic:** a
  deepagents loop with read tools (and, for the write commands, scoped writes)
  rooted at the repository.
- Sinscribe fails gracefully outside a git repository, strips every API key from
  the environment its agent's shell receives, and keeps secrets out of all
  output and logs.

Built with [Ink](https://github.com/vadimdemedes/ink),
[LangChain](https://github.com/langchain-ai/langchainjs) /
[LangGraph](https://github.com/langchain-ai/langgraphjs), and
[deepagents](https://github.com/langchain-ai/deepagents). See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the internals and
[`DESIGN.md`](DESIGN.md) for design decisions.

## Development

```bash
pnpm dev pr --dry-run      # run from source (tsx); note: no "--" separator
pnpm test                  # vitest
pnpm lint:check && pnpm format:check
pnpm build
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the same checks
on push and PR, on Node 20 and 22. Setup, quality gates, house conventions, and
the release process live in
[`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md).

## Why I built this

I basically live in the terminal, and lately it feels like every other tool
shipping in tech is a CLI. I wanted to see what it actually takes to build one
today — so I made something I'd use every day: a little assistant that shaves
friction off my real workflow. _The Pragmatic Programmer_ puts it well: invest
in your tools, sharpen them, and let them make you faster. This is me taking
that advice literally.

## Credits

Inspired by [openwiki](https://github.com/langchain-ai/openwiki), whose
agentic-CLI skeleton (provider abstraction, config/secrets layer, agent loop)
gave Sinscribe its starting point. The domain — git workflows, templates, and
per-branch sessions — is Sinscribe's own.
