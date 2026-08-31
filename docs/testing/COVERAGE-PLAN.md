# Coverage plan

State of the automated test suite, what this session added, and what is left.

Regenerate the numbers below with:

```bash
pnpm test:coverage
```

## Runner

The suite runs on **vitest** (`pnpm test` → `vitest run`), not Jest. There is no
`vitest.config.*`; it runs on defaults and picks up `test/**/*.test.ts`. Coverage
uses `@vitest/coverage-v8`, pinned to the same version as vitest itself.

Conventions the suite follows, and which new tests must match:

- Mock only at true I/O boundaries — `../src/llm/single-shot.js`,
  `../src/llm/agent.js`, `node:child_process`, `node:os`. Never mock the module
  under test or its pure collaborators.
- Use real throwaway git repositories via `test/git-fixture.ts`
  (`makeTempDir`, `initRepo`, `git`, `removeDir`) rather than faking git output.
- Redirect `node:os`'s `homedir()` in any test that touches `~/.sinscribe`, so a
  run can never read or write the developer's real configuration.
- Strict TypeScript, no `any` — `pnpm lint:check` runs type-checked rules over
  `test/` and will reject an unsafe assignment.

## Before and after

| Metric     | Before             | After                  | Delta |
| ---------- | ------------------ | ---------------------- | ----- |
| Statements | 52.72% (2097/3977) | **58.66%** (2333/3977) | +5.94 |
| Branches   | 44.94% (1475/3282) | **52.07%** (1709/3282) | +7.13 |
| Functions  | 51.61% (416/806)   | **57.81%** (466/806)   | +6.20 |
| Lines      | 52.69% (2056/3902) | **58.71%** (2291/3902) | +6.02 |

Test files 42 → **47**. Tests 589 → **738** (+149).

Branches gained the most, which is the point: the work targeted error paths and
input validation rather than happy paths that were already exercised.

## What this session covered

Modules were ranked by business criticality × complexity × coverage gap, and
worked in that order.

| #   | Module                      | Lines before | Lines after | Test file                       |
| --- | --------------------------- | ------------ | ----------- | ------------------------------- |
| 1   | `src/llm/agent.ts`          | 8.3%         | 66.7%       | `test/agent.test.ts` (extended) |
| 2   | `src/domain/commit.ts`      | 0.0%         | **100.0%**  | `test/commit.test.ts` (new)     |
| 3   | `src/domain/template.ts`    | 0.0%         | 98.0%       | `test/template.test.ts` (new)   |
| 4   | `src/domain/execute.ts`     | 0.0%         | 81.5%       | `test/execute.test.ts` (new)    |
| 5   | `src/llm/events.ts`         | 10.5%        | **100.0%**  | `test/events.test.ts` (new)     |
| 6   | `src/templates/registry.ts` | 61.9%        | **100.0%**  | `test/registry.test.ts` (new)   |
| —   | `src/domain/agents.ts`      | 0.0%         | 87.0%       | covered via dispatch tests      |
| —   | `src/domain/context.ts`     | 0.0%         | 75.0%       | covered via dispatch tests      |
| —   | `src/domain/docs.ts`        | 0.0%         | 75.0%       | covered via dispatch tests      |

### `src/llm/agent.ts` — stream normalisation

`parseStreamEvent` turns every LangGraph chunk into a `RunEvent`, and a
misparse loses output silently. Now covered: both tuple shapes (`[mode, payload]`
and `[namespace, mode, payload]`), all four assistant-detection strategies
(`_getType`, `role`/`type`, the serialized-class `id` array, bare `content`), a
throwing `_getType`, human messages being dropped, tool and reasoning blocks
being stripped from mixed content, all six tool event names, synthetic tool-call
ids, and the 200-character argument cap. `createThreadId` is covered for its
prefix, path-digest stability, digest divergence across directories, and
per-call uniqueness.

`buildShellEnv` — the secret-scrubbing security invariant — already had three
tests; they were left as they were.

### `src/domain/commit.ts` — the commit command

Reached 100% of lines. Covers header assembly, `--no-gitmoji`, scope precedence
(`--scope` beats the model), scope trimming and blank-scope handling, the
`chore` fallback for an unknown or missing type, body placement, breaking
changes (both the `!` marker and the footer, in the right order), non-string
body/breaking values being ignored, the empty-subject error, non-JSON output,
a rejected model call, the two distinct empty-diff messages, and `--all` seeing
an unstaged edit the default path does not.

### `src/domain/template.ts` — the template command

All five actions, both real and dry-run. Includes the built-in → user-tier
copy-on-edit, `$EDITOR` selection, a non-zero editor exit, an editor that cannot
be launched, and the case where the user's edit leaves the file unparseable (the
command reports it rather than claiming success). `node:os`'s `homedir()` is
redirected to a temporary directory, verified not to touch the real
`~/.sinscribe`.

### `src/domain/execute.ts` — dispatch

`isAgenticCommand` and `isOfflineCommand` are asserted exhaustively against a
fixture list of all ten command variants, so adding a command without
classifying it fails a test. Every command is routed through `executeDryRun` and
checked for its own banner, which proves the dispatch table end to end, and one
assertion proves no dry run of any command reaches the agent runner.

### `src/llm/events.ts` — content extraction

100%. The important guarantee is that reasoning and tool blocks never leak into
user-visible text; that is asserted directly, alongside string content, block
arrays, bare strings inside arrays, missing and non-string `text` fields,
non-object entries, and unreadable content.

### `src/templates/registry.ts` — three-tier resolution

100%. Covers the full override chain (`builtin < user < project`), the project
tier being ignored without a repository root, unparseable files being skipped
rather than failing the load, sorting, and the kind-mismatch error that a
same-named template of a different kind produces. `saveUserTemplate` is checked
for validate-before-write, including that no file is left behind on failure.

## What remains uncovered, and why

| Area                                                                                                    | Lines | Coverage | Why it is still uncovered                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | ----- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ui/menu-app.tsx`                                                                                   | 343   | 0.0%     | The interactive dashboard: alt-screen rendering, mouse hit-testing, and a large state machine. Needs a TTY harness, not unit tests.                                                       |
| `src/ui/menu-view.tsx`                                                                                  | 272   | 57.7%    | Pickers and prompts. The pure parts are covered by `ui-render`/`menu-items`; the rest is interactive.                                                                                     |
| `src/ui/prompt-review.tsx`, `pr-review.tsx`, `docs-review.tsx`, `handoff-review.tsx`, `agent-setup.tsx` | 490   | 0–41%    | Review flows. Their domain layers (`createPrRun`, `createPromptRun`, `createHandoffRun`) are well covered; what is missing is the Ink wiring.                                             |
| `src/cli.tsx`                                                                                           | 110   | 0.0%     | Process entry: argv routing, signal handling, terminal setup. `cli-version` and `cli-signals` spawn the built binary for the paths that matter most.                                      |
| `src/llm/agent.ts` (`runAgent`)                                                                         | 84    | 66.7%    | The remaining third is the deepagents loop itself — constructing the agent and consuming a live stream. Needs a fake `createDeepAgent`, which means mocking a third-party module's shape. |
| `src/env.ts`                                                                                            | 77    | 40.2%    | `getCredentialDiagnostics` and the redaction helpers. Straightforward to cover; ranked below this session's targets only because credentials never render unredacted anywhere else.       |
| `src/llm/single-shot.ts`                                                                                | 41    | 43.9%    | `stripMarkdownFence` and `extractJsonObject` are covered; the streaming body, retry wrapper, and watchdog interaction are not.                                                            |
| `src/llm/model.ts`                                                                                      | 37    | 32.4%    | Provider branching in `createModel` constructs real SDK clients. Testable by asserting on the constructed instance rather than calling it.                                                |
| `src/ui/mouse.tsx`, `term.ts`                                                                           | 101   | 21–28%   | Terminal escape sequences and capability detection. `mouse-protocol.ts` — the pure parser — is at 91.7%.                                                                                  |
| `src/credentials.tsx`                                                                                   | 20    | 0.0%     | First-run Ink wizard. `needsCredentialSetup` is the pure part worth covering.                                                                                                             |

Nothing here is uncovered because it is untestable; it is uncovered because the
cost/benefit ranked below the items above. The two genuinely awkward areas are
the Ink roots (need a TTY harness) and `runAgent` (needs a third-party mock).

## Ranked backlog for a future session

1. **`src/env.ts` — credential diagnostics** (77 lines, 40.2%). Pure functions
   over an injectable env map. Assert that `createCredentialPreview` never
   reveals more than six leading and four trailing characters, that short values
   are fully masked, that the four `source` states are reported correctly, and
   that `formatEnv` orders managed keys first. Highest value per unit of effort
   left, and it guards a security property.
2. **`src/llm/single-shot.ts` — retry and watchdog** (41 lines, 43.9%). Inject a
   fake model whose `stream` throws a retryable error, then succeeds; assert the
   `status` events, that partial text from a failed attempt is discarded, and
   that the shared deadline is not extended by a retry. Use fake timers.
3. **`src/llm/model.ts` — provider construction** (37 lines, 32.4%). Assert that
   each provider yields the right client class and base URL, that
   `openai-compatible` without a base URL fails with a named error, that
   `--api-key` never mutates `process.env`, and that an invalid
   `SINSCRIBE_MODEL_ID` is rejected.
4. **`src/llm/agent.ts` — `runAgent`** (28 uncovered lines). Mock `deepagents`'
   `createDeepAgent` to return a fake async stream. Assert the
   `providerSupportsAgentic` refusal happens before any credential read, that
   `LocalShellBackend` is constructed with `inheritEnv: false`, and that the
   watchdog aborts a silent stream.
5. **`src/credentials.tsx` — `needsCredentialSetup`** (small). Assert it returns
   false for an explicit `--api-key`, false for `local-cli` providers, and true
   only when the provider's key env var is absent.
6. **`src/ui/pr-review.tsx` and `prompt-review.tsx`** (268 lines). Extract the
   state reducers from the Ink components first, then test those as units. The
   components themselves need the TTY harness below.
7. **A TTY harness for the Ink roots** (`menu-app`, `chat-app`, `run-app`,
   ~490 lines). The largest remaining block and the largest investment. Worth
   doing only once a rendering regression actually costs something; `ui-render`
   and `run-view` already cover the frame-building logic where the known
   overflow hazards live.

## Constraints these tests hold to

- **No real network.** The two model runners are mocked at their module
  boundary; nothing in the suite opens a socket.
- **No real clock dependence.** `createThreadId` uniqueness is asserted by
  inequality rather than by timing, and no test sleeps.
- **No test-order dependence.** Verified with two `vitest run --sequence.shuffle`
  runs: 738 passed in both.
- **No shared mutable state.** Every test that touches the filesystem creates its
  own temporary directory in `beforeEach` and removes it in `afterEach`.
- **No real home directory access.** Tests touching `~/.sinscribe` redirect
  `homedir()`; confirmed the real directory is unchanged after a run.
