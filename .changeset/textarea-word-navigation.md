---
"sinscribe": minor
---

# ✨ feat: cursor-based word navigation in text prompts

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
