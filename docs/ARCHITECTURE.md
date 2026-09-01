# Architecture

How Sinscribe is put together, and why. This is the maintainer's reference: if
you are here to use the CLI, read [`../README.md`](../README.md) instead; if you
are here to submit a change, read [`CONTRIBUTING.md`](./CONTRIBUTING.md).

Everything below describes the code as it stands. Line references are a reading
aid, not a contract — the symbol names are the stable part.

## The shape of the thing

Sinscribe is a single-process Node CLI. It reads git state, asks a language
model for prose, and renders the result — either as one line of stdout or as an
[Ink](https://github.com/vadimdemedes/ink) terminal UI. There is no daemon, no
server, and no local database.

Three properties drive most of the design:

- **Git is read locally, never by the model.** For the commands that produce a
  PR description, commit message, branch name, or agent prompt, the CLI collects
  the diff itself and makes exactly one model call.
- **`--dry-run` reads no credentials.** This is enforced by control flow, not by
  discipline: the dry-run branch returns before the environment is ever loaded.
- **Secrets do not reach the agent's shell.** The commands that _do_ explore the
  repository get a real shell, with every API-key variable stripped out of it.

## Module map

### Entry and configuration

| File                  | Responsibility                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/cli.tsx`         | Process entry. `main()` routing, process guards, `exitWhenFlushed()`, the no-Ink print path, and the three Ink roots.          |
| `src/commands.ts`     | Pure argv parser: `parseCommand()`, the `CommandSpec`/`CliCommand` unions, per-subcommand parsers, `getHelpText()`. No I/O.    |
| `src/constants.ts`    | Provider registry (`PROVIDER_CONFIGS`), env-var key names, `SECRET_ENV_KEYS`, `SINSCRIBE_VERSION`, provider/model normalizers. |
| `src/env.ts`          | `~/.sinscribe` paths, `loadSinscribeEnv()`, `saveSinscribeEnv()`, `.env` parse/format, credential diagnostics.                 |
| `src/credentials.tsx` | `needsCredentialSetup()` and the first-run Ink key wizard.                                                                     |

### `src/domain/` — one module per command

Each module owns its git reads, its prompt assembly, and its choice of runner.

| File                                                                      | Responsibility                                                                                                                           |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `execute.ts`                                                              | Dispatch: `executeCommand()`, `executeDryRun()`, `isAgenticCommand()`, `isOfflineCommand()`.                                             |
| `prompts.ts`                                                              | Every system-prompt builder, `appendRules()`, `JSON_ONLY_INSTRUCTION`.                                                                   |
| `pr.ts`                                                                   | PR context gathering and the `createPrRun()` generate/refine/approve cycle.                                                              |
| `prompt.ts`                                                               | Agent task prompts: `createPromptRun()`, kind inference, description resolution.                                                         |
| `commit.ts`                                                               | `GITMOJI_BY_TYPE`, commit context, message assembly.                                                                                     |
| `branch.ts`                                                               | Branch-name suggestions with a deterministic fallback.                                                                                   |
| `branch-actions.ts`                                                       | The only module that writes to git (`checkout -b`, `branch -m`) plus session re-keying. Called from the UI, never from `executeCommand`. |
| `context.ts`, `docs.ts`, `agents.ts`                                      | Agentic commands. Each builds a prompt and calls `runAgent()`; the CLI writes `--out`, not the model.                                    |
| `agent-setup.ts`                                                          | Two-pass agentic flow: `planAgentSetup()` (read-only) then `writeAgentSetup()` (path-whitelisted).                                       |
| `handoff.ts`                                                              | `HANDOFF.md` generate/save cycle.                                                                                                        |
| `template.ts`                                                             | `list`/`show`/`add`/`edit`/`path`. The only command needing neither model nor credentials.                                               |
| `rules.ts`                                                                | Two-tier free-text rules appended to every system prompt.                                                                                |
| `pr-export.ts`, `prompt-export.ts`, `docs-export.ts`, `handoff-export.ts` | Export filenames and markdown envelopes.                                                                                                 |
| `errors.ts`                                                               | `CliError` — the "print cleanly, exit 1, no stack trace" class.                                                                          |

### `src/git/` — plumbing

| File        | Responsibility                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `run.ts`    | `runGit()` (tolerant), `tryGit()` (null on failure), `runGitStrict()` (throws). Every git subprocess passes through here. |
| `repo.ts`   | Repo detection, current branch, base-ref resolution, branch create/rename, repo root.                                     |
| `diff.ts`   | `DiffInfo`, staged/worktree/merge-base diffs, `parseNumStat`, `capText`.                                                  |
| `ticket.ts` | Ticket extraction, slugs, branch-ref sanitising, `BRANCH_TYPES`.                                                          |

### `src/llm/`

| File             | Responsibility                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `model.ts`       | `resolveModel()` — the single place a chat model is constructed.                                                    |
| `single-shot.ts` | Tier 1: `runSingleShot()`, plus `stripMarkdownFence()` and `extractJsonObject()`.                                   |
| `agent.ts`       | Tier 2: `runAgent()`, `buildShellEnv()`, `createThreadId()`, `parseStreamEvent()`.                                  |
| `events.ts`      | `RunEvent`, `RunCallbacks`, `getContentText()`.                                                                     |
| `errors.ts`      | Error classification, retry with backoff, `toFriendlyError()`, `InvalidModelJsonError`.                             |
| `watchdog.ts`    | Inactivity watchdog and `raceAbort()`.                                                                              |
| `healthcheck.ts` | `testProviderConnection()` for the settings "Test connection" step.                                                 |
| `kiro-cli/`      | `ChatKiroCli` (a `BaseChatModel` driving the `kiro-cli` binary), its generated agent config, and an output cleaner. |

### `src/templates/`, `src/session/`, `src/util/`

`templates/schema.ts` parses frontmatter into `Template`; `templates/registry.ts`
loads the three tiers; `templates/render.ts` fills slots.
`session/store.ts` holds branch-keyed JSON. `util/clipboard.ts` shells out to the
platform copy command.

### `src/ui/`

Three Ink roots: `run-app.tsx` (one command, streaming), `menu-app.tsx` (the
alt-screen dashboard), `chat-app.tsx` (multi-turn chat). Review flows
(`pr-review`, `prompt-review`, `docs-review`, `handoff-review`, `agent-setup`)
drive a generate/refine/approve loop. Shared rendering lives in `run-view.tsx`
and `menu-view.tsx`; terminal and input infrastructure in `theme.ts`, `term.ts`,
`viewport.ts`, `text-buffer.ts`, `editor.ts`, `mouse.tsx`, and `no-color.ts`.

`templates/*.md` at the package root ships six PR templates: `andersoftware`
(the default), `github`, `google`, `kubernetes`, `shopify`, `stripe`. The schema
allows `commit` and `branch` templates; none ship today.

## Key abstractions

### `RunEvent` — the streaming contract

```ts
export type RunEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; call: string }
  | { type: "tool_end"; id: string; name: string; status: "error" | "finished" }
  | { type: "status"; message: string }
  | { type: "debug"; message: string };
```

Both runners emit this, and every consumer speaks it: the Ink apps, and the
plain-stdout path in `cli.tsx`. It exists so a UI never has to know whether the
text came from a LangChain stream chunk or a LangGraph tuple — `parseStreamEvent`
absorbs that difference. Adding a fourth UI means writing a `RunEvent` consumer
and touching neither runner.

`RunCallbacks` (`{ debug?, onEvent? }`) is threaded through every `run*` and
`dryRun*` signature for the same reason.

### `CommandSpec` / `CliCommand` — parsing as a pure function

`CommandSpec` is a discriminated union over `name`, one variant per subcommand.
`CliCommand` wraps it with `kind: "help" | "version" | "error" | "run"`.

Parsing does no I/O and returns an error variant rather than throwing or calling
`process.exit`, which is what makes the whole surface unit-testable. Because both
switches in `execute.ts` are exhaustive over `CommandSpec["name"]`, adding a
command without wiring it up is a compile error rather than a runtime surprise.

### `Template` / `PlaceholderSpec` — typed slots with a declared source

```ts
export type PlaceholderType = "string" | "markdown" | "list";
export type PlaceholderSource = "llm" | "git" | "branch";
export type TemplateKind = "pr" | "commit" | "branch";
```

The `from` field is the load-bearing one. `from: git` and `from: branch` slots
are filled locally from the branch name and ticket; only `from: llm` slots are
requested from the model, as JSON keyed by slot name. Two consequences:

- `--dry-run` can render a genuine scaffold, with the deterministic slots already
  filled and the model slots left as `{{...}}`.
- A required `from: branch` slot with no detectable ticket is a hard `CliError`
  telling you to pass `--ticket`, rather than an invented ticket number.

### `BranchSession`

```ts
export type BranchSession = {
  version: 1;
  branch: string;
  context: SessionContext | null;
  pr: GeneratedPr | null;
  createdAt: string;
  updatedAt: string;
};
```

`context` is the business context you typed (feature, ticket, requirements,
target branch); `pr` is the last approved description. `version` is present so a
future format change can be detected rather than guessed at.

### `ResolvedModel`

`{ provider, modelId, model }`, where `model` is one of `ChatAnthropic`,
`ChatOpenAI`, `ChatOpenRouter`, or `ChatKiroCli`. Produced only by
`resolveModel()`, which is the single point where credentials are read and a
model is constructed.

## The two-tier runner

This is the central design decision, and the one most worth preserving.

### Tier 1 — single-shot (`src/llm/single-shot.ts`)

The CLI gathers everything itself, sends exactly two messages (system + human),
and streams one reply. No tools, no agent loop, no checkpointer. The model
receives a diff and returns text; it cannot read a file, run a command, or touch
the working tree, because it was never given anything to do that with.

Used by `pr`, `prompt`, `commit`, `branch`, and the `handoff` sub-flow.

Retries are owned here: `resolveModel` is called with `maxRetries: 0` so the
SDK's transport retries do not multiply this layer's backoff, and a single
overall deadline is shared across attempts so a retried stall cannot extend the
cap.

### Tier 2 — agentic (`src/llm/agent.ts`)

`createDeepAgent` over a `LocalShellBackend` rooted at the working directory,
with `virtualMode: true` (so `/` is the repository root), a 100 KB output cap,
and a 120-second per-subprocess timeout. A module-level `MemorySaver` gives chat
turns shared history within one process.

Used by `context`, `docs`, `agents`, `agent-setup`, and `chat` — the commands
whose whole job is to explore a repository the CLI cannot summarise in advance.

### Where the choice is actually made

**Per domain module, not by a central predicate.** `executeCommand`'s switch
routes to a domain function, and that function calls its runner:

| Command              | Runner          | Call site                                     |
| -------------------- | --------------- | --------------------------------------------- |
| `pr`                 | `runSingleShot` | `src/domain/pr.ts`                            |
| `prompt`             | `runSingleShot` | `src/domain/prompt.ts`                        |
| `commit`             | `runSingleShot` | `src/domain/commit.ts`                        |
| `branch`             | `runSingleShot` | `src/domain/branch.ts`                        |
| `handoff` (sub-flow) | `runSingleShot` | `src/domain/handoff.ts`                       |
| `context`            | `runAgent`      | `src/domain/context.ts`                       |
| `docs`               | `runAgent`      | `src/domain/docs.ts`                          |
| `agents`             | `runAgent`      | `src/domain/agents.ts`                        |
| `agent-setup`        | `runAgent` ×2   | `src/domain/agent-setup.ts`                   |
| `chat`               | `runAgent`      | `src/domain/execute.ts`, inline in the switch |
| `template`           | none            | `src/domain/template.ts`                      |

The two exported predicates in `execute.ts` are **not** the tier selector, and
misreading them is the easiest mistake to make here:

- `isAgenticCommand()` is a **UI** predicate. Its only consumer is `run-app.tsx`,
  deciding whether `text` and `tool_*` events reach the visible log. `prompt` is
  absent from it despite being LLM-backed, because a `prompt` run has no tool
  activity worth streaming.
- `isOfflineCommand()` is consumed only by `cli.tsx`, to skip credential loading
  entirely.

Two exceptions to state precisely, so nobody "discovers" them as bugs:

- `pr` and `branch` each make a **second** single-shot call when the first reply
  fails to parse as JSON (`InvalidModelJsonError`), re-asking with an explicit
  format reminder. Still zero tools, zero checkpointer.
- `agent-setup` is **two** agent calls: a read-only planning pass, then a write
  pass against an explicit path whitelist — deepagents' `write_file` refuses to
  overwrite an existing file, so updates need the second pass to be deliberate.

Tier 1's "no tools" property is enforced in three places: the absence of any tool
wiring in `runSingleShot`, `tools: []` in `createDeepAgent`, and — for the
`kiro-cli` provider, whose engine is someone else's CLI — a generated agent
config that declares `"tools": []`.

## Control flow

### `sinscribe pr`, end to end

1. `main()` installs process guards, then `parseCommand(process.argv.slice(2))`
   returns `{ kind: "run", command: { name: "pr", ... }, flags }`.
2. If `flags.dryRun`, `executeDryRun` runs and the process returns — **before**
   `loadSinscribeEnv()` is ever called.
3. `isOfflineCommand` is false, so `loadSinscribeEnv()` merges
   `~/.sinscribe/.env` into `process.env` without overwriting anything already
   set, and `initThemeFromEnv()` applies the saved theme.
4. With `-p/--print` or a non-TTY stdin, `runPrint()` calls `executeCommand` and
   writes the result to stdout. Otherwise `RunApp` renders and — because `pr` has
   a review flow — hands off to `PrReviewFlow`.
5. `createPrRun()` calls `gatherPrContext()` once: `ensureGitRepo`, repo root,
   rules, template resolution, current branch, session load, base-ref resolution,
   ticket extraction, and the diff plus commit log in parallel. An empty diff
   stops here with a `CliError`.
6. `generate(null)` builds the system prompt from the template's LLM slots and
   the user prompt from branch, base, business context, commits, changed files,
   and the capped patch, then calls `runSingleShot`.
7. The reply goes through `extractJsonObject`, and only the declared LLM slots
   are read out of it. `renderTemplate` merges those with the git-derived values.
8. You approve, refine with feedback (another `generate`, carrying the previous
   description forward), or reject. Only `approve()` writes the session and the
   `--out` file.

`runPr()` is the non-interactive collapse of the same cycle: `generate(null)`
then `approve()`.

### `sinscribe context`, for contrast

Steps 1–4 are identical, but `RunApp` sees `isAgenticCommand` as true and streams
the log. `runContext` builds a prompt and calls `runAgent`, which:

1. Checks `providerSupportsAgentic()` **first**, before any credential or network
   access, so an unsupported provider fails with a clear message instead of an
   opaque tool-calling error.
2. Resolves the model, builds the deep agent, and streams with
   `streamMode: ["messages", "tools"]` and `subgraphs: true`.
3. Feeds every chunk through `parseStreamEvent`, which normalises both
   `[mode, payload]` and `[namespace, mode, payload]` tuples into `RunEvent`s.

Empty output is a `CliError`, and `--out` is written by the CLI rather than by
the model.

## Layered configuration

Three layered systems, resolving in deliberately different directions.

| System      | Order                                                                | Rule                                                                  |
| ----------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Templates   | `builtin` → `~/.sinscribe/templates` → `<repo>/.sinscribe/templates` | Highest tier wins by name                                             |
| Rules       | `~/.sinscribe/rules.md` + `<repo>/.sinscribe/rules.md`               | **Additive** — both are included, each labelled                       |
| Credentials | `process.env` over `~/.sinscribe/.env`                               | Environment wins; per-run flags win over both and are never persisted |

Rules are additive on purpose: a personal rule ("always mention the ticket") and
a team rule ("never use the word 'simply'") should both apply, and each is
labelled in the prompt so their provenance stays visible.

One sharp edge in template resolution: `resolveTemplate` matches on name across
**all** kinds before checking the kind. A user-tier `commit` template named
`github` therefore shadows the built-in `pr` template of the same name and
produces `Template github is a commit template, not a pr template.` rather than
silently falling back to the built-in.

## Extension points

### Add a provider

1. Add the literal to the `SinscribeProvider` union in `src/constants.ts`.
2. Add its API-key env constant, and add that constant to `SECRET_ENV_KEYS` if
   it is a secret (base URLs are not).
3. Add a `PROVIDER_CONFIGS` entry. The first entry in `modelOptions` becomes the
   provider's default model.
4. Add it to `SELECTABLE_PROVIDERS` to make it appear in the settings picker.
5. Add the env keys to `managedEnvKeys` in `src/env.ts`, and to the list in
   `getCredentialDiagnostics()` if they should show in diagnostics.
6. Touch `src/llm/model.ts` **only if the SDK class differs.** `createModel`
   special-cases Anthropic and OpenRouter and otherwise falls through to
   `ChatOpenAI` with a base URL — so an OpenAI-compatible provider needs no code
   there at all.

### Add a template

Drop a `.md` file with valid frontmatter into any tier directory, or run
`sinscribe template add <name>`, which validates before writing so a broken
template never lands in the library. Required frontmatter: `name` and `kind`.
Placeholder names must be lower_snake_case; `type` defaults to `string`, `from`
to `llm`, and `required` to **true**.

Unparseable template files are skipped silently rather than failing the run —
`template list` shows only valid ones.

### Add a command

1. `SUBCOMMANDS` and a variant in `CommandSpec` (`src/commands.ts`).
2. A `parseX(args)` function plus a case in `parseSubcommand`.
3. An entry in `getHelpText()`.
4. `src/domain/<name>.ts` exporting `runX()` and `dryRunX()`.
5. Cases in both `executeCommand` and `executeDryRun`. TypeScript will tell you
   if you forget one.
6. Add to `isAgenticCommand` only if it streams tool activity worth rendering;
   to `isOfflineCommand` only if it needs neither model nor credentials.
7. Optionally an Ink flow, a branch in `RunApp`, and a `MENU_ITEMS` entry.

## Design decisions and their tradeoffs

**Two tiers instead of one agent.** An agent that could run `git diff` itself
would be simpler to describe and strictly more capable. It would also be
non-deterministic about which files it looked at, slower, more expensive, and
able to write to your working tree during what you asked to be a description of
it. The split buys determinism and a hard safety property for the commands you
run dozens of times a day, at the cost of two code paths to maintain.

**`--dry-run` is checked before the environment loads.** Placing the branch
before `loadSinscribeEnv()` turns "no credentials are read" from a promise into a
structural fact — there is no code path from the dry-run branch to a credential.
The cost is that the check lives in `main()` rather than alongside each command.

**The agent's shell gets the real environment minus secrets.** `LocalShellBackend`
is constructed with `inheritEnv: false` and an explicit `env: buildShellEnv()`,
which copies `process.env` and removes every key in `SECRET_ENV_KEYS`. The shell
still sees `PATH`, `HOME`, the SSH agent, and git config — so private remotes and
signed commits work — but prompt-injected repository content cannot read or
exfiltrate an API key through it. The model itself is unaffected: it already
received the credential when `resolveModel` constructed it. A bare empty
environment was not an option; it breaks `PATH` outside macOS.

The complementary "do not read `.env` files" instruction in the agent system
prompts is exactly that — an instruction. The scrubbing above is the enforced
half.

**Git writes happen in the CLI layer.** `branch-actions.ts` runs
`git checkout -b` and `git branch -m`, and is called only from the menu, never
from `executeCommand`. So `sinscribe branch` can create a branch without the
`branch` command ever handing the model a tool: the model proposes names, you
pick one, and the CLI runs git.

**A lossy session key, guarded by the branch name inside the file.** Branch names
are sanitised into filenames, which is lossy — two branches can collide on one
key. The file therefore carries the raw branch name as the source of truth, and
`loadSession` returns `null` when it does not match the branch being asked about.
`deleteSession` reuses the same guard, so a collision can lose a read but can
never delete another branch's session. The tradeoff is a rare, silent "no session
found" instead of a rare, loud wrong answer.

**Sessions are world-readable; credentials are not.** `~/.sinscribe/.env` is
written `0600` inside a `0700` directory, with an explicit `chmod` after each
write. Session files get default permissions. This asymmetry is deliberate:
sessions hold branch and feature text that belongs to the repository, not
secrets. Do not "fix" it in either direction.

**`.sinscribe/.gitignore` ignores `sessions/`, not `*`.** The same directory holds
the project template tier and project rules, both of which teams are meant to
commit. The file is written once and never overwritten, so your edits survive.

**The diff is merge-base-relative and byte-capped.** Diffing from the merge base
keeps commits that landed on the target branch after you branched out of your
description. The 50 KB cap on the patch bounds prompt size and cost; truncation is
reported rather than hidden, and the file list is always sent in full.

**A watchdog on top of `AbortSignal`.** The signal alone is not hang-proof: a
provider that ignores it, or a socket that stalls without erroring, leaves a
`for await` loop suspended forever. `raceAbort` races every chunk read against
the watchdog so the loop always terminates. Timeouts are named `TimeoutError` so
the existing classifier treats them as retryable network failures with no special
casing.

**The process exits explicitly after flushing.** Node exits when the event loop
drains, and a lingering SDK keep-alive socket can prevent that indefinitely —
which presented as the CLI freezing after it had already printed its answer.
`exitWhenFlushed` queues empty writes behind all real output and exits from their
callbacks.

**The menu re-prints its result after Ink exits.** The dashboard runs on the
alternate screen buffer, which the terminal discards on exit — so generated text
rendered there would vanish. The last result is captured and re-printed on the
normal screen. The same applies to the docs review, which clamps its final frame
to a tail of the document.

**`kiro-cli` is driven as a subprocess, not as an API.** AWS restricts Q
subscriptions to approved applications; a third-party client that registers
itself is refused regardless of how correct its request is. Driving the official
CLI means the approved client makes the call as itself, and the wire format stays
AWS's responsibility. The cost is a provider that cannot do tool calling, so it
declares `supportsAgentic: false` and the agentic commands refuse it up front
with a message naming the commands that do work.

## Known gaps

- **No test coverage of the network path.** `src/llm/model.ts` is tested for
  resolution logic, not for real provider calls, and the Ink roots are not
  exercised end to end. Rendering helpers, event folding, and the input layer are
  covered as units.
- **`getHelpText()` is global.** `sinscribe pr --help` prints the same text as
  `sinscribe --help`; there is no per-command help.
- **The interactive menu is one large module.** `src/ui/menu-app.tsx` carries the
  dashboard, its flows, and its state transitions in a single file.
- **`openai-compatible` ships no model presets.** Its `modelOptions` is empty by
  design, so `--model-id` or `SINSCRIBE_MODEL_ID` is required.
