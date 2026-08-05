# sinscribe

## 1.2.0

### Minor Changes

- 3752086: Carry a prompting session forward with `HANDOFF.md`

  After you approve a feature/bugfix prompt, `sinscribe prompt` now offers to write a
  `HANDOFF.md` at the repo root — a snapshot of where the branch stands (what was
  done, what was decided, what is still open), not an accumulated log. The draft is
  model-written and reviewable in the same approve/modify loop as the prompt itself;
  the `## Last updated` date is stamped by the CLI rather than asked of the model.

  The next `sinscribe prompt` on that branch reads the file back and feeds it to the
  model, so a second iteration starts warm instead of re-deriving settled ground. A
  handoff written on a different branch is still passed along, but labeled as such
  rather than presented as the current state.

  Adds `--handoff` to write the file without asking — the only route in `-p/--print`
  and other non-TTY runs, which cannot ask. `--dry-run` reports whether a handoff
  would be read back in and whether one would be written.

### Patch Changes

- 3752086: Stop the review screens from freezing short terminals

  The PR, prompt and docs review screens sized their preview panel with a floor of
  six rows, which on a short terminal handed back rows that did not exist. The
  resulting frame reached the terminal's height, and Ink then cleared and repainted
  the whole screen on every render instead of diffing — which reads as a freeze.
  Measured: the prompt review screen rendered 20 rows into a 15-row terminal.

  The preview is now dropped entirely when there is no room for it, leaving a
  one-line note pointing at "View full". Regression tests assert both the frame
  height and the absence of the `ESC[3J` (erase scrollback) sequence that is unique
  to Ink's full-clear path.

## 1.1.0

### Minor Changes

- 9e03a7d: Fix the freeze on paste, and grow the text prompts with the terminal.

  Pasting a block of text into any prompt could lock the CLI up until the process
  was killed. Three things stacked: Ink delivers one input event per OS read (a
  pty hands a paste over in ~1 KB pieces, so 50 KB meant ~49 synchronous React
  commits), it recomputes the Yoga layout — a full `wrap-ansi` pass over the
  whole accumulated text — on every one of them, and the prompts rendered that
  text unbounded. Once a frame reaches the terminal's height, Ink stops diffing
  and writes a full clear-and-repaint per render, including the scrollback erase,
  synchronously to the TTY. Measured before the fix: 2.9 s of blocked event loop
  for 50 KB, 14.4 s and 5.3 MB of escape output for 100 KB.

  Prompts now render only the visual rows that fit, windowed around the caret
  (new offset-exact `wrapRows`/`visibleRowWindow`/`visibleSlice` helpers), so
  their height no longer depends on how much text they hold, and paste chunks are
  coalesced into a single insert. The same windowing closes the other places the
  frame could outgrow the terminal: `TailPanel` counted logical lines rather than
  wrapped rows, the streamed run log was uncapped in direct runs and in the docs
  flow, saved session context was rendered raw, and long tool/status lines were
  charged one row while wrapping to several.

  With the height now bounded, the boxes size themselves from the viewport
  instead of a fixed six lines: a tall window gets a taller input (up to 20 rows
  for the long-form prompts, 8 for the chat) and a short one shrinks to fit.

  Also fixed along the way: a paste split across reads could leave a bare
  carriage return that submitted half of it and silently dropped the rest; text
  pasted into a single-line prompt glued words together where its newlines were
  removed; and pasted line breaks now survive into the chat message.

## 1.0.0

### Major Changes

- # 🔖 release: v1.0.0 — first stable release

  Sinscribe graduates out of beta. The CLI surface (commands, flags, env vars,
  config layout under `~/.sinscribe`), the three-tier template system, and the
  session store are now stable and covered by semver: breaking changes to any
  of them will require a major release. OpenCode Go and Amazon Q Developer
  (Kiro CLI) are the recommended, regularly tested providers; the remaining
  providers stay selectable as-is.

### Minor Changes

- 1338708: # ✨ feat: "Rules" — author-defined instructions for every AI command

  A new menu item, **Project rules** (CONFIG section), lets you write free-text
  rules that get added to the system prompt of every LLM-backed command —
  `chat`, `pr`, `commit`, `branch`, `prompt`, `context`, `docs`, and `agents`.

  - Pick "Your rules" (personal, `~/.sinscribe/rules.md`, applies to every repo)
    or "Project rules" (team-shared, `<repo>/.sinscribe/rules.md`, meant to be
    committed) and edit them in a multi-line textarea, same as the session
    context wizard.
  - **Both tiers combine additively** when both exist — your personal
    preferences and the repo's rules both apply, labeled separately, rather than
    one silently replacing the other (unlike the template system's
    highest-tier-wins behavior).
  - Every `--dry-run` output gains a `Rules:` line summarizing what's active.
  - No rules files present ⇒ zero behavior change: every existing system prompt
    is byte-identical to before.

  `pr`/`commit`/`branch` still make exactly one model call each via
  `runSingleShot`, with no tools or checkpointer — rules are plain text read
  from local files before that one call, same as the diff or branch name.

- # ✨ feat: `/exit` returns to the main menu from menu-launched chat

  Typing `/exit` (or `/quit`) in an interactive chat that was opened from the
  main menu now returns to the menu instead of quitting the app, so a chat
  detour no longer costs the whole session. Chat started directly from the
  command line (`sinscribe <message>`) still exits the process, and Ctrl+C
  keeps its quit-everything behavior everywhere.

- daf6a38: Initial versioned beta release of Sinscribe, a git-centric developer-workflow CLI for generating PR descriptions, commit messages, branch names, and project/agent context briefs. Inspired by openwiki.

  This changeset covers the work already on `main` but never versioned:

  - Initial public release of the CLI: single-shot `pr` / `commit` / `branch` commands and agentic `context` / `agents` / `chat` commands, over a provider registry, a three-tier template system, and a config/secrets layer.
  - PR flow: template preview and scrollable full-text review.
  - Hardened prompt-kind inference and the `pr` prompt rules.

- 7e1f89e: # 🔖 feat: freeze-proof runtime, AWS Kiro provider, responsive TUI

  - **CLI freeze fix**: every model call now has an inactivity watchdog
    (120 s, AbortSignal + hang-proof `raceAbort` loop; 10-minute overall cap
    for single-shot commands) with retryable-network classification; global
    `unhandledRejection`/`uncaughtException` guards; the process force-exits
    after a stdout/stderr flush so lingering SDK sockets can never hang the
    terminal; git subprocesses are capped at 30 s with
    `GIT_TERMINAL_PROMPT=0`.
  - **Amazon Q Developer provider (`kiro-cli`)**: drives AWS's official Kiro
    CLI as a subprocess (`kiro-cli chat --no-interactive`, prompt over stdin)
    so an AWS-approved application makes the call — AWS gates Q subscriptions
    to approved apps and refuses self-registered third-party clients. No
    credential is stored: run `kiro-cli login` once. Tools are disabled via a
    generated `tools: []` agent, keeping the commands single-shot
    (`pr`/`commit`/`branch`/`prompt` only).
  - **Responsive TUI + centralized components**: shared `viewport`
    (`contentRows`), `Panel`/`TailPanel`, branding, and review helpers;
    height-aware review clamps replace the fixed 16-line tails; `RunLog`,
    chat history, and the main menu window themselves so no view overflows
    very small or very large terminals.

- 1338708: # ✨ feat: cursor-based word navigation in text prompts

  Text prompts (the chat input, single-line `InlinePrompt`, and multi-line
  `MultilinePrompt`) now carry a real cursor instead of only appending at the
  end, so editing feels like a terminal/readline:

  - **Word motion**: Option/Alt+←/→ (both the xterm modified-arrow and the
    Esc+b/Esc+f encodings), plus Ctrl+←/→, jump by word.
  - **Word delete**: Option/Alt+Backspace and Ctrl+W delete the previous word;
    Esc+d deletes the next word.
  - **Cursor & line motion**: ←/→ move by code point (emoji never split),
    Ctrl+A/Ctrl+E jump to line start/end, and ↑/↓ move between lines in the
    multi-line prompt with a cursor-following viewport.
  - **Bug fix**: the chat input no longer deletes a character when an arrow,
    Home/End, or other special key is pressed — unrecognized keys are now
    no-ops.

  The editing logic lives in a pure, fully unit-tested module
  (`src/ui/editor.ts`), with an end-to-end harness that feeds real terminal
  escape sequences through Ink into the rendered prompts. Selection
  (Shift+Option+Arrow) is intentionally left for a follow-up.

- 040d890: # 🔖 feat: `--version` / `-v` flag

  `sinscribe --version` (or `-v`) prints the installed version and exits, like
  `node -v`. The flag short-circuits before subcommand parsing, so it wins over
  anything else on the command line and needs no credentials, network, or git
  repo. `SINSCRIBE_VERSION` is now read from `package.json` at runtime instead
  of a second hardcoded copy that had drifted (`0.0.1` vs the released
  `0.1.0-beta.3`), which also corrects the version shown in the TUI footer and
  in exported PR/prompt/docs file headers.

### Patch Changes

- c2ad346: Harden the agentic commands (`context` / `agents` / `chat`): the shell tool no longer inherits the process's secret API-key environment variables, so repository content can no longer read or exfiltrate credentials through the shell. The user's PATH / HOME / SSH / git environment is preserved, so git and normal tooling keep working.
- 1338708: # 🔖 fix: add "Interactive chat" to the menu

  Bare `sinscribe` opened the menu-driven dashboard, but the interactive chat
  session was only reachable by running `sinscribe <message>` directly from the
  shell — it had no entry in the menu itself. Added "Interactive chat" as the
  first, always-available item; picking it exits the menu and launches the same
  chat session (menu and chat use different Ink render modes — alt-screen vs.
  not — so chat launches as its own render pass right after the menu's exits,
  rather than being nested inside it).

- # 💄 style: mark recommended providers in the picker

  The AI provider picker now suffixes OpenCode Go and Amazon Q Developer
  (Kiro CLI) — the two providers Sinscribe is regularly tested against — with
  "(Recommended)". All other providers remain selectable, unchanged.

## 0.1.0-beta.4

### Minor Changes

- 040d890: # 🔖 feat: `--version` / `-v` flag

  `sinscribe --version` (or `-v`) prints the installed version and exits, like
  `node -v`. The flag short-circuits before subcommand parsing, so it wins over
  anything else on the command line and needs no credentials, network, or git
  repo. `SINSCRIBE_VERSION` is now read from `package.json` at runtime instead
  of a second hardcoded copy that had drifted (`0.0.1` vs the released
  `0.1.0-beta.3`), which also corrects the version shown in the TUI footer and
  in exported PR/prompt/docs file headers.

## 0.1.0-beta.3

### Minor Changes

- 1338708: # ✨ feat: "Rules" — author-defined instructions for every AI command

  A new menu item, **Project rules** (CONFIG section), lets you write free-text
  rules that get added to the system prompt of every LLM-backed command —
  `chat`, `pr`, `commit`, `branch`, `prompt`, `context`, `docs`, and `agents`.

  - Pick "Your rules" (personal, `~/.sinscribe/rules.md`, applies to every repo)
    or "Project rules" (team-shared, `<repo>/.sinscribe/rules.md`, meant to be
    committed) and edit them in a multi-line textarea, same as the session
    context wizard.
  - **Both tiers combine additively** when both exist — your personal
    preferences and the repo's rules both apply, labeled separately, rather than
    one silently replacing the other (unlike the template system's
    highest-tier-wins behavior).
  - Every `--dry-run` output gains a `Rules:` line summarizing what's active.
  - No rules files present ⇒ zero behavior change: every existing system prompt
    is byte-identical to before.

  `pr`/`commit`/`branch` still make exactly one model call each via
  `runSingleShot`, with no tools or checkpointer — rules are plain text read
  from local files before that one call, same as the diff or branch name.

- 1338708: # ✨ feat: cursor-based word navigation in text prompts

  Text prompts (the chat input, single-line `InlinePrompt`, and multi-line
  `MultilinePrompt`) now carry a real cursor instead of only appending at the
  end, so editing feels like a terminal/readline:

  - **Word motion**: Option/Alt+←/→ (both the xterm modified-arrow and the
    Esc+b/Esc+f encodings), plus Ctrl+←/→, jump by word.
  - **Word delete**: Option/Alt+Backspace and Ctrl+W delete the previous word;
    Esc+d deletes the next word.
  - **Cursor & line motion**: ←/→ move by code point (emoji never split),
    Ctrl+A/Ctrl+E jump to line start/end, and ↑/↓ move between lines in the
    multi-line prompt with a cursor-following viewport.
  - **Bug fix**: the chat input no longer deletes a character when an arrow,
    Home/End, or other special key is pressed — unrecognized keys are now
    no-ops.

  The editing logic lives in a pure, fully unit-tested module
  (`src/ui/editor.ts`), with an end-to-end harness that feeds real terminal
  escape sequences through Ink into the rendered prompts. Selection
  (Shift+Option+Arrow) is intentionally left for a follow-up.

### Patch Changes

- 1338708: # 🔖 fix: add "Interactive chat" to the menu

  Bare `sinscribe` opened the menu-driven dashboard, but the interactive chat
  session was only reachable by running `sinscribe <message>` directly from the
  shell — it had no entry in the menu itself. Added "Interactive chat" as the
  first, always-available item; picking it exits the menu and launches the same
  chat session (menu and chat use different Ink render modes — alt-screen vs.
  not — so chat launches as its own render pass right after the menu's exits,
  rather than being nested inside it).

## 0.1.0-beta.2

### Minor Changes

- 7e1f89e: # 🔖 feat: freeze-proof runtime, AWS Kiro provider, responsive TUI

  - **CLI freeze fix**: every model call now has an inactivity watchdog
    (120 s, AbortSignal + hang-proof `raceAbort` loop; 10-minute overall cap
    for single-shot commands) with retryable-network classification; global
    `unhandledRejection`/`uncaughtException` guards; the process force-exits
    after a stdout/stderr flush so lingering SDK sockets can never hang the
    terminal; git subprocesses are capped at 30 s with
    `GIT_TERMINAL_PROMPT=0`.
  - **Amazon Q Developer provider (`kiro-cli`)**: drives AWS's official Kiro
    CLI as a subprocess (`kiro-cli chat --no-interactive`, prompt over stdin)
    so an AWS-approved application makes the call — AWS gates Q subscriptions
    to approved apps and refuses self-registered third-party clients. No
    credential is stored: run `kiro-cli login` once. Tools are disabled via a
    generated `tools: []` agent, keeping the commands single-shot
    (`pr`/`commit`/`branch`/`prompt` only).
  - **Responsive TUI + centralized components**: shared `viewport`
    (`contentRows`), `Panel`/`TailPanel`, branding, and review helpers;
    height-aware review clamps replace the fixed 16-line tails; `RunLog`,
    chat history, and the main menu window themselves so no view overflows
    very small or very large terminals.

## 0.1.0-beta.1

### Patch Changes

- c2ad346: Harden the agentic commands (`context` / `agents` / `chat`): the shell tool no longer inherits the process's secret API-key environment variables, so repository content can no longer read or exfiltrate credentials through the shell. The user's PATH / HOME / SSH / git environment is preserved, so git and normal tooling keep working.

## 0.1.0-beta.0

### Minor Changes

- daf6a38: Initial versioned beta release of Sinscribe, a git-centric developer-workflow CLI for generating PR descriptions, commit messages, branch names, and project/agent context briefs. Inspired by openwiki.

  This changeset covers the work already on `main` but never versioned:

  - Initial public release of the CLI: single-shot `pr` / `commit` / `branch` commands and agentic `context` / `agents` / `chat` commands, over a provider registry, a three-tier template system, and a config/secrets layer.
  - PR flow: template preview and scrollable full-text review.
  - Hardened prompt-kind inference and the `pr` prompt rules.
