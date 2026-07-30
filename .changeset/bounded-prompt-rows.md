---
"sinscribe": minor
---

Fix the freeze on paste, and grow the text prompts with the terminal.

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
