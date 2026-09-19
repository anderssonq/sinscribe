# Sinscribe — Design

Git-centric developer-workflow assistant CLI. Inspired by openwiki's agentic-CLI
skeleton; the git-workflow domain, templates, and per-branch sessions are
Sinscribe's own.
Binary name: `sinscribe` (package `sinscribe`). Config home: `~/.sinscribe/.env`.

## 1. Command surface

Subcommands are positional (rather than mode flags) because there are several of
them; the flag-parsing style (hand-rolled loop → discriminated union) is kept.
The commands and every flag are listed in [`README.md`](README.md#commands); how
the single-shot/agentic tier is picked per command is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#the-two-tier-runner). This file
records only the decisions behind them.

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

The placeholder schema, the three override tiers and the resolution sharp edges
are documented once in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#key-abstractions)
and [`README.md`](README.md#templates). The decision worth recording here: slots
declare **where their value comes from** (`from: llm|git|branch|input`) rather
than being free-form, so `--dry-run` can fill the deterministic ones with no
model call and a missing required slot fails before a request is ever sent.

## 3. Folder structure

See the module map in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#module-map),
which is the single copy — a second tree in this file only drifts from it.

## 4. Git-integration layer

- **Repo detection**: `git rev-parse --is-inside-work-tree`; every git-dependent command
  fails fast with `Not inside a git repository.` (exit 1) — including in `--dry-run`.
- **Staged diff** (`commit`): `git diff --staged --unified=3` + `--name-status`;
  empty → "Nothing staged. Stage changes with `git add` (or pass --all)."
- **PR diff** (`pr`): base ref resolution order: `--base` flag → `origin/HEAD`
  symbolic ref → first existing of `origin/main`, `origin/master`,
  `origin/develop`, `main`, `master`, `develop` → error with hint.
  Diff = `git diff <base>...HEAD` plus `git log <base>..HEAD --oneline`.
- **Size capping**: diffs are byte-capped (50 KB, `MAX_DIFF_BYTES`) and cut at the
  last newline, with a `[diff truncated to N bytes]` marker so prompts stay
  bounded (the agent's LocalShellBackend caps output similarly via
  `maxOutputBytes`).
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

1. **Default provider = opencode-go, default model = Kimi K2.7 Code**, changed
   2026-07-08 from the original openrouter/GLM choice — the CLI still targets
   cheap models first. Which providers are recommended versus merely selectable
   is recorded in §5 and not repeated here.
2. **`branch` uses the LLM only when input is a description**; pure ticket ID input is
   handled deterministically.
3. **Interactive mode kept** (bare `sinscribe` opens the Ink chat/agent); the
   subcommands are the primary UX.
4. **deepagents dependency kept** — the two-tier split itself is an invariant, not
   an open decision; see `docs/ARCHITECTURE.md`. What stays open is whether the
   dependency earns its weight for only five commands.
