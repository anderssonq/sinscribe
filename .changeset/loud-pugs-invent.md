---
"sinscribe": minor
---

✨ feat(ui): richer loading indicator — pixel-grid wavefront, shimmering label, tenths timer

The "the model is thinking" indicator every screen shares is now a 6x3 braille
dot grid driving a chevron wavefront, with a highlight sweeping across the
label and an elapsed timer counting in tenths at a fixed width. It still
occupies exactly one terminal row, and every call site keeps the same
`<Spinner label="..." />` API.

Piping the CLI no longer animates (a static frame, no per-frame line), and
`SINSCRIBE_REDUCED_MOTION=1` freezes the grid on a TTY while leaving the timer
running.
