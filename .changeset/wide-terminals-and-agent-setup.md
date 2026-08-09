---
"sinscribe": minor
---

Centre the UI on wide terminals, and add "Set up project agents".

**The UI no longer sprawls across a wide terminal.** Every root was a full-width
column with no centring and one hardcoded width cap, so at 200 columns the
actions menu sat in a 62-column box against the left edge with ~140 empty
columns beside it, while every prose view — the scroll reader, help, the run
log, the review panels, the text prompts — stretched edge to edge and wrapped at
~195 characters. Content is now capped at 120 columns and centred, and the menu
uses the space it gained: past 100 columns the action list keeps its readable
width and a detail panel opens beside it with the focused action's full hint
plus the branch, target, session and change figures that the header otherwise
crams into one truncated line. Below 120 columns nothing changes — the cap and
the gutter are both inert, so existing terminals render exactly as before.

Width now comes from one place (`contentColumns` on the shared viewport)
alongside the row budget that was already there. That pairing matters: the
render width and the terminal width can now differ, and wrapping text to the
wrong one under-counts the rows a frame costs — which is the same overflow that
made Ink clear and repaint the whole screen per render. The centring offset is a
real layout margin rather than padded strings, so mouse hit-testing still lands
on the right rows.

**New menu action: "Set up project agents".** It reads the repository, asks
about what the code cannot show it, and writes one specialised agent definition
per role into `.claude/agents` — a backend agent for the framework actually in
use, a frontend agent for the one actually in use, plus the cross-cutting ones
(commits, tests, review) the project's own scripts and CI justify. Because the
agent loop cannot stop to ask a question mid-run, it is two passes with the
interview between them: a read-only analysis reports the stack, a proposed
roster, and only the questions it genuinely cannot answer from a file; you
answer (or skip) each one and trim the roster; the second pass writes the files,
streaming each one as it lands.

Definitions that already exist are never silently overwritten — you choose
between refreshing them in place, preserving hand-written parts, and keeping
them untouched, in which case they are dropped from the write pass entirely
rather than merely excluded by instruction. Also available as `sinscribe
agent-setup`, with the usual credential-free `--dry-run`; a non-interactive run
skips the interview and reports the questions it would have asked.
