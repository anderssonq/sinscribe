---
"sinscribe": patch
---

Stop the review screens from freezing short terminals

The PR, prompt and docs review screens sized their preview panel with a floor of
six rows, which on a short terminal handed back rows that did not exist. The
resulting frame reached the terminal's height, and Ink then cleared and repainted
the whole screen on every render instead of diffing — which reads as a freeze.
Measured: the prompt review screen rendered 20 rows into a 15-row terminal.

The preview is now dropped entirely when there is no room for it, leaving a
one-line note pointing at "View full". Regression tests assert both the frame
height and the absence of the `ESC[3J` (erase scrollback) sequence that is unique
to Ink's full-clear path.
