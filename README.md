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
> **Stable (v1.0.0).** Sinscribe is in daily use and its CLI surface —
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
  requirements, target branch) and feed it to every generation.
- **Customizable templates** — six built-in house styles plus your own, with
  typed placeholders filled deterministically from git or by the model.
- **Deterministic `--dry-run`** on every command: no model call, no credentials
  read — useful for previewing detection and in CI.

## Prerequisites

- Node.js >= 20
- git
- An API key for a supported provider (OpenCode Go by default — see
  [Configuration](#configuration))

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

```bash
cd your-repo
sinscribe                 # interactive chat + menu over the current repo
sinscribe pr              # draft a PR description from your local changes
sinscribe commit          # Conventional Commit message from staged changes
sinscribe pr --dry-run    # preview detection + scaffold, no API key needed
```

The first interactive run asks for your provider API key and stores it in
`~/.sinscribe/.env`.

## Commands

| Command              | What it does                                                            |
| -------------------- | ----------------------------------------------------------------------- |
| `sinscribe`          | Interactive chat agent + menu over the current repo                     |
| `sinscribe pr`       | PR/MR description from local changes vs the target branch               |
| `sinscribe commit`   | Conventional Commit + Gitmoji message from staged changes               |
| `sinscribe branch`   | Branch-name suggestions from a description/ticket                       |
| `sinscribe prompt`   | Copy-ready feature/bugfix task prompt for your AI coding agent          |
| `sinscribe context`  | Structured project-context brief (markdown or JSON)                     |
| `sinscribe docs`     | Project documentation with mermaid diagrams                             |
| `sinscribe agents`   | Generate/refresh `CLAUDE.md` + `AGENTS.md` from the repo                |
| `sinscribe template` | Manage the template library (`list` / `show` / `add` / `edit` / `path`) |

### Common flags

Every command supports:

| Flag                | Effect                                                             |
| ------------------- | ------------------------------------------------------------------ |
| `--dry-run`         | Deterministic scaffold: no LLM call, no credentials read           |
| `-p, --print`       | One-shot non-interactive run, result on stdout (default off a TTY) |
| `--model-id <id>`   | Model override for this run                                        |
| `--provider <name>` | Provider override for this run (not persisted)                     |
| `--api-key <key>`   | API key override for this run (not persisted)                      |

### Examples

```bash
# Pull requests
sinscribe pr --template github --base origin/main --out PR.md
sinscribe pr --base develop --staged       # only staged changes, vs develop
sinscribe pr --dry-run                      # branch/ticket/diff detection + scaffold

# Commits & branches
sinscribe commit --scope api --no-gitmoji
sinscribe branch ABC-123 add retry logic to uploader   # → fix/... suggestions

# Prompts & project understanding
sinscribe prompt --type bugfix uploader crashes on empty files
sinscribe prompt --handoff -p "add retry logic"   # also writes HANDOFF.md
sinscribe context --format json --out context.json
sinscribe agents --target claude --update

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

```markdown
## Where things stand

## What was done this session

## Key decisions

## Open questions

## Next steps

## Known issues / blockers
```

The next `sinscribe prompt` on that branch reads the file back and feeds it to
the model, so a second iteration starts warm instead of re-deriving settled
ground. A handoff written on a different branch is still passed along, but
labeled as such rather than presented as the current state.

`--handoff` writes the file without asking — the only route in `-p/--print`
and other non-TTY runs, which cannot ask. The file is yours to commit or
ignore; Sinscribe never adds it to `.gitignore`.

## Configuration

On first interactive run, Sinscribe asks for your provider API key and stores it
in `~/.sinscribe/.env` (directory `0700`, file `0600`). Process env vars always
win over the file, and nothing secret is ever printed.

```bash
# ~/.sinscribe/.env (all optional; created by the CLI)
SINSCRIBE_PROVIDER="opencode-go"    # opencode-go | openrouter | baseten | fireworks | openai | openai-compatible | anthropic | kiro-cli
SINSCRIBE_MODEL_ID="kimi-k2.7-code" # default model for the provider
OPENCODE_API_KEY="..."
ANTHROPIC_API_KEY="..."             # if you switch to anthropic
                                    # (kiro-cli needs no key — see below)
SINSCRIBE_TICKET_PATTERN="(T-\d+)"  # optional custom ticket regex
SINSCRIBE_THEME="ayu-dark"          # TUI color theme (set from the menu's Theme picker)
```

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

| Provider                                                                         | Status                                                                      |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `opencode-go`                                                                    | **Recommended** — the default; supported and regularly tested               |
| `kiro-cli`                                                                       | **Recommended** — drives AWS's official Kiro CLI; single-shot commands only |
| `openrouter`, `anthropic`, `openai`, `baseten`, `fireworks`, `openai-compatible` | Selectable — not actively maintained or regularly tested                    |

> [!WARNING]
> Only the recommended providers (OpenCode Go and Kiro CLI) are exercised
> regularly. The others ship as-is and may lag behind their vendors' API
> changes — verify one with **Test connection** before relying on it.

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
`claude-sonnet-4.5` (1.30x). `auto` (the default) lets Kiro choose.

**Why a subprocess and not the API?** AWS restricts Q subscriptions to
_approved applications_: a third-party client that registers itself is
refused with `AccessDeniedException: "Your subscription does not support
this application"` however correct its request is. Rather than impersonate
an approved client, Sinscribe drives the official one — the approved client
makes the call, as itself — which also means the wire format stays AWS's
responsibility rather than something we reverse-engineer.

**Tools are off, by construction.** Sinscribe runs `kiro-cli chat` with a
generated agent that declares `"tools": []`, so the model can write text but
has no tool to touch your working tree — that is what keeps `pr`/`commit`/
`branch`/`prompt` single-shot. (The `--trust-tools=` flag does _not_ do
this: it only governs auto-approval, and was verified to still let the model
read the filesystem.) The agent config lives under `~/.sinscribe/kiro-agent/`
and never touches your own Kiro agents.

**Limitation:** agentic commands (`context`/`docs`/`agents`/`chat`) need
tool calling and exit with a clear message asking you to switch providers.

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
context it opens straight into the context form, and the "Create PR
description" / "Create branch name" items require a context before they run. A
session captures **business context** per branch — feature description, ticket
ID, requirements, and the **target branch** it merges into — stored in
`<repo>/.sinscribe/sessions/<branch>.json`.

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

## How it works

- **`pr` / `commit` / `branch` / `prompt` are single-shot:** the CLI computes the
  diff and context locally and makes one model call — the model never touches
  your repo. (Branch creation/rename is a plain git call the CLI makes after you
  pick a name; the model only suggests names.)
- **`context` / `docs` / `agents` / chat are agentic:** a deepagents loop with
  read tools (and, for `agents`, write) rooted at the repository.
- Sinscribe fails gracefully outside a git repository, never lets the agent read
  `.env` files, and keeps secrets out of all output and logs.

Built with [Ink](https://github.com/vadimdemedes/ink),
[LangChain](https://github.com/langchain-ai/langchainjs) /
[LangGraph](https://github.com/langchain-ai/langgraphjs), and
[deepagents](https://github.com/langchain-ai/deepagents). See
[`DESIGN.md`](DESIGN.md) for the internals, and
[`documentation.md`](documentation.md) for the maintainer reference.

## Development

```bash
pnpm dev pr --dry-run      # run from source (tsx); note: no "--" separator
pnpm test                  # vitest
pnpm lint:check && pnpm format:check
pnpm build
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the same checks
on push and PR. Setup, quality gates, and house conventions live in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

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
