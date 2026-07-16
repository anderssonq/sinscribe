---
"sinscribe": minor
---

# 🔖 feat: freeze-proof runtime, AWS Kiro provider, responsive TUI

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
