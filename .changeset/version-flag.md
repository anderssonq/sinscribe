---
"sinscribe": minor
---

# 🔖 feat: `--version` / `-v` flag

`sinscribe --version` (or `-v`) prints the installed version and exits, like
`node -v`. The flag short-circuits before subcommand parsing, so it wins over
anything else on the command line and needs no credentials, network, or git
repo. `SINSCRIBE_VERSION` is now read from `package.json` at runtime instead
of a second hardcoded copy that had drifted (`0.0.1` vs the released
`0.1.0-beta.3`), which also corrects the version shown in the TUI footer and
in exported PR/prompt/docs file headers.
