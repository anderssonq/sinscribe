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
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#the-runner-tiers). This file
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
- `recover`: the branch it would open (from local refs — no fetch), checkout vs
  worktree, ticket, base, diagnosis path, and the files the AI would read first
  (listed from the branch's tree, so accurate before it is opened).

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
  (everything but the CLIs) vs `"local-cli"` (kiro-cli, claude-cli).
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
- **`claude-cli` provider** (`src/llm/claude-cli/`): the same pattern for
  Claude Code — `claude -p --output-format stream-json
--include-partial-messages`, system text as `--system-prompt`, prompt over
  stdin, answer taken from `text_delta` stream events (the CLI's final
  `result` event is where sign-in failures arrive, on stdout). Tools are
  removed with `--tools ""` (availability, not approval). Isolation flags
  (`--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`,
  `--exclude-dynamic-system-prompt-sections`) and a neutral cwd keep the
  user's hooks, MCP servers, skills and CLAUDE.md out: measured 2026-10-03,
  without them a one-word prompt carried ~133k tokens of the user's
  environment; with them, ~420. Secret env keys are stripped from the child
  so a key in `~/.sinscribe/.env` cannot silently replace the user's login.
- **OpenCode Go request identity** (`src/llm/opencode-go.ts`): since
  2026-09-06 OpenCode Go answers 400 to requests without `x-opencode-session`
  ("cannot be routed efficiently"). It is the sticky-routing and prompt-cache
  key, so it must be stable per conversation: single-shot runs mint one per
  invocation; the agentic tier passes its LangGraph `thread_id`, which `chat`
  keeps for the whole conversation. Requests also carry
  `User-Agent: sinscribe/<version>` and `x-opencode-client: sinscribe`, as the
  docs ask third-party clients to.
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

## 5b. Spec plan (`sinscribe plan`, 2026-10-07)

Ported from the spec-driven workflow of `agent-skills`
(spec → plan → tasks → build, human-gated), keeping its discipline and closing
the gaps it leaves to prose. The requirements use EARS acceptance criteria as
[Kiro specs](https://kiro.dev/docs/specs/) do, and the stage split matches
[GitHub spec-kit](https://github.com/github/spec-kit); both are tracked in the
standards registry (§5d) and stamped in each document's header.

- **The files are the source of truth, not the conversation.** Approval is
  recorded in `.sinscribe/specs/<branch>/index.md` (a JSON comment written only by code);
  stale/edited/next are recomputed from content hashes on every read, never
  stored. A teammate, a new session or another agent sees the same state, and
  approval is never inferred from chat. Task checkboxes are normalised out of
  the hash, so progress never reads as a spec edit.
- **Traceability is mechanical.** `REQ-n` / `AC-n.m` / `T-n` ids with
  `Implements:` / `Depends on:` lines are parsed, and approving `tasks.md` is
  blocked by dangling references, duplicates or cycles (agent-skills has no ids;
  coverage was a reviewer's job).
- **The LLM writes prose; code owns state.** Framing, nav links, the design's
  "Context read" list, the handoff's status table and its append-only `## Log`
  are deterministic. Regenerating the handoff feeds the agent's log and an
  authoritative checkbox summary back in, last in the prompt.
- **Loop = strategy A.** Sinscribe does not implement code: `loop-prompt.md`
  is a deterministic contract for the user's own coding agent (one task,
  verify, tick, log, commit unless the rules forbid it; stop at checkpoints,
  blockers and spec gaps, which become _spec deltas_ instead of silent edits).
  `--sync` is offline and deterministic. _Strategy C_ — Sinscribe spawning
  `claude -p` with edit/test tools per task, in a worktree, with a budget cap —
  is the follow-up; it needs per-task tool allowlists derived from Verify
  commands before it is safe.
- **Tier 3 (read-only explore) serves two features: this one and the AI
  session draft (§5c).** Requirements
  and design are better grounded in the code, but the user's CLI providers
  must keep working, so the claude CLI explores with `--restricted --tools
Read,Glob,Grep` (verified on 2.1.293: out-of-repo reads and `.env` reads —
  Grep included — are refused), API-key providers with a write-denied
  `FilesystemBackend`, Kiro with a per-run agent whose only tool is an
  untrusted `fs_read` (verified on kiro-cli 2.3.0: a _trusted_ `fs_read`
  ignores `allowedPaths` and read `/etc/hosts`; untrusted, out-of-repo and
  `.env` reads are rejected, the agent lives in a per-run directory a repo
  cannot shadow, and the answer is the first `> ` message after the last tool
  line), and everything else falls back to single-shot + a repo brief.
- **`.sinscribe/specs/` is tracked** (unlike `.sinscribe/handoff.md`/`agent-prompt.md`): the plan is
  part of the branch's work. Public repos publish their plans; the dry run
  shows whether the directory is ignored.

## 5c. AI session context (menu, 2026-10-07)

Writing the session context by hand is where a branch's work usually starts,
and most of what it needs is already in the repository. The menu can draft it.

- **The author gives the direction; the AI backs it.** The direction (what the
  session is for) is required and kept in the author's words at the start of
  `feature` — enforced in code for a short direction, not left to the prompt.
  The model's job is evidence: code and markdown documents (reports, notes,
  specs, handoffs) related to the direction.
- **Tier 3, not a new tier.** The first round explores read-only, so every
  provider works: claude CLI and API-key providers read the code; the rest get
  single-shot with the repo brief plus a docs digest (tracked `.md` files and
  excerpts of the ones matching the direction or ticket). Feedback rounds are
  single-shot over the previous draft; "look again" explores again.
- **The preview is where the goal is settled.** It shows sources and open
  questions; the author can refine the goal, add details or answers, send the
  AI back into the repository, edit by hand, approve or cancel. Nothing is
  written before approval.
- **Code owns what the model cannot be trusted with.** The target branch is
  never the model's; a ticket survives only if the branch or the evidence
  contains it; a source survives only if it is a tracked, non-secret file;
  every field is redacted.
- **No schema change.** Sources (and open questions, when saved unanswered)
  ride at the end of `requirements`, so `pr`, `prompt`, `branch` and `plan`
  read the drafted context exactly like a typed one.

## 5d. Agent standards (registry and drift, 2026-10-08)

Everything Sinscribe writes for an agent to read (`AGENTS.md`, `CLAUDE.md`,
`.claude/agents/*.md`, spec plans) follows a published standard, and those
standards move as fast as the agents do. So the answer to "what is this based
on?" lives in code, not in memory:

- **One registry.** `src/standards/registry.ts` lists every standard with its
  canonical URL, the commands that follow it, the date and version it was last
  verified against, the concrete rules (line budgets, required frontmatter,
  name shape) and how to detect an upstream change. Prompts read their limits
  from it; nothing repeats them as literals.
- **The code owns the format, the model writes the prose.** After `agents` and
  `agent-setup` write their files, `src/standards/validate.ts` checks them
  against the same rules and appends a "Standards check" block to the run's
  summary. Warnings, never errors: the files are already on disk.
- **AGENTS.md is canonical.** It is the cross-agent open standard (Agentic AI
  Foundation). Claude Code reads it only when there is no CLAUDE.md, so
  `agents --target both` writes a CLAUDE.md that imports it with `@AGENTS.md`
  instead of a second copy that drifts.
- **No per-tool copies.** Kiro, Cursor, GitHub Copilot and Codex read
  AGENTS.md natively (Gemini CLI does when `context.fileName` lists it), so
  Sinscribe does not write `.kiro/steering/`, `.cursor/rules/` or
  `.github/copilot-instructions.md` duplicates. Those formats are tracked in the
  registry with a `readsAgentsMd` note, which the `agents` dry run prints; if a
  tool drops AGENTS.md support, the drift check is where it shows up first.
- **Subagents do not pin a model.** A hard-coded `model:` goes stale with
  every model release; definitions inherit the session's model, and read-only
  roles get a restricted `tools:` list.
- **Drift is an alarm, not a memory.** `pnpm standards:check` compares each
  tracked source (latest commit, release tag, or the hash of a `.md` docs page)
  with `standards.lock.json`. `.github/workflows/standards-drift.yml` runs it
  weekly and opens or comments on one `standards-drift` issue. Closing it means
  reading the source, then either adjusting rules/prompts and bumping
  `verifiedOn` (with a changeset) or noting "no impact" — and in both cases
  committing the refreshed lock (`pnpm standards:check --update`).
- **No quality claims yet.** The validator checks shape, not usefulness. Until
  an evaluation harness exists, nothing here says the output is "better".

## 5e. Recovery mode (`sinscribe recover`, 2026-10-08)

Teams that let a CI pipeline of AI agents build a branch end up with branches
the pipeline gave up on: fix attempts exhausted, tests red, a draft PR and a
diagnosis somewhere. `recover` is the developer's way back in.

- **Generic on purpose.** Nothing knows which pipeline, tracker or CI produced
  the branch: the input is a branch name or ticket, the evidence is what the
  branch carries, and the diagnosis is a file (`--from`). No tracker API, no
  credentials beyond the model's. Team specifics — protected test or lock
  paths, the test command — go in project rules, which every step follows.
- **A session draft in recovery mode, not a new flow.** Recovery reuses §5c
  wholesale: tier 3 read-only exploration, the review, the deterministic
  guards. It adds a pre-filled goal, read-first candidates computed without a
  model (ticket paths, then the reports and docs the branch changed), the
  diagnosis, and rules that shape the draft into a takeover brief
  (`Failure:` / `Remaining:` lines). The output is an ordinary session
  context, so the existing bugfix prompt and spec plan take it from there.
- **Never the base branch.** Recovering `main` reads a tree without anything
  the pipeline wrote, and the draft then plans around the absence of its own
  work (a plan that recreates locked tests). The CLI, the dry run and the menu
  refuse the base branch and ask for the failed branch or ticket.
- **The goal is Sinscribe's, the feature is the branch's.** The pre-filled
  recovery goal is not kept in `feature` the way an author's direction is,
  and an echo of it is stripped — `feature` titles everything built on it.
  Words the author adds to the goal are kept.
- **Never weaken the tests.** Pipelines hold agents to tests (often
  hash-locked). The recovery rules forbid proposing to edit, skip or delete
  them; a test that looks wrong becomes an open question for the developer.
- **Git is conservative.** An in-place checkout is refused over uncommitted
  tracked changes (`--worktree` is the alternative); an existing worktree for
  the branch is reused; only a strict fast-forward is applied; `.worktrees/` is
  excluded through `.git/info/exclude`, never the team's `.gitignore`. Pushing
  stays manual — it is what re-triggers the pipeline.
- **Print mode saves only on request.** Interactive runs save after approval;
  `-p` prints the draft and saves it only with `--save`, mirroring
  `prompt --handoff`.

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
