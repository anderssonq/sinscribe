# sinscribe

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
