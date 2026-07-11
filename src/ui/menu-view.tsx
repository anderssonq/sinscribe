import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { LOGO_LINES, logoVisible, useTerminalSize } from "./logo.js";
import { MENU_ITEMS, type MenuChoice, type MenuItem } from "./menu-items.js";
import { useOnClick, useOnWheel } from "./mouse.js";
import { appendInput, deleteLast, visibleTail } from "./text-buffer.js";
import { theme } from "./theme.js";

/**
 * True for SGR mouse sequences that Ink surfaces as literal text ("[<0;12;5M")
 * when mouse reporting is on — text prompts must never append them. Matches
 * the full sequence shape so pasted text that merely starts with "[<" passes.
 */
function isMouseNoise(value: string): boolean {
  return /^\[<\d+;\d+;\d+[Mm]/u.test(value);
}

/**
 * Rows the SelectList chrome occupies outside its item window: the header
 * above, the picker title, the box's two borders, its two scroll indicators,
 * the footer hint, and a cushion. The logo's rows (when shown) are subtracted
 * separately so a long list windows to what actually fits on screen.
 */
const SELECT_CHROME_ROWS = 12;

/** One selectable row: a Box registered as a click target (hooks can't go in loops). */
function ClickableRow({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  const ref = useOnClick(onClick);

  return <Box ref={ref}>{children}</Box>;
}

type MainMenuProps = {
  onSelect: (choice: MenuChoice) => void;
  isActive: boolean;
  items?: MenuItem[];
};

/** Arrow-key select menu (replaces the free-text chat input). */
export function MainMenu({
  onSelect,
  isActive,
  items = MENU_ITEMS,
}: MainMenuProps) {
  const [cursor, setCursor] = useState(0);

  useInput(
    (value, key) => {
      // k/j mirror the arrow keys for neovim-style navigation.
      if (key.upArrow || value === "k") {
        setCursor((current) => (current + items.length - 1) % items.length);
        return;
      }

      if (key.downArrow || value === "j") {
        setCursor((current) => (current + 1) % items.length);
        return;
      }

      if (key.return) {
        if (!items[cursor].disabled) {
          onSelect(items[cursor].id);
        }
        return;
      }

      if (key.escape || value === "q") {
        onSelect("exit");
      }
    },
    { isActive },
  );

  useOnWheel((direction) => {
    if (!isActive) {
      return;
    }

    setCursor((current) =>
      direction === "up"
        ? (current + items.length - 1) % items.length
        : (current + 1) % items.length,
    );
  });

  const { columns } = useTerminalSize();
  const boxWidth = Math.min(62, columns);
  // 2 border columns + paddingX 1 on each side.
  const innerWidth = Math.max(0, boxWidth - 4);
  const title = "─ Acciones ";
  const topLine = `╭${title}${"─".repeat(Math.max(0, boxWidth - 2 - title.length))}╮`;

  const rows: ReactNode[] = [];
  let previousSection: string | undefined;

  items.forEach((item, index) => {
    if (item.section && item.section !== previousSection) {
      previousSection = item.section;
      rows.push(
        <Text color={theme.dim} key={`section-${item.section}`}>
          {item.section}
        </Text>,
      );
    }

    const focused = index === cursor;
    const labelColor = item.disabled
      ? theme.dim
      : item.danger
        ? theme.error
        : focused
          ? theme.selected
          : theme.body;

    rows.push(
      <ClickableRow
        key={item.id}
        onClick={() => {
          if (!item.disabled) {
            onSelect(item.id);
          }
        }}
      >
        <Box width={innerWidth}>
          <Text wrap="truncate-end">
            {/* One stable child list; only props toggle between renders —
                toggling a *middle* child of a <Text> between null and a node
                corrupts Ink 5's re-render reconciliation (labels below smear:
                "AI settings" → "AI tation", etc.). */}
            <Text backgroundColor={focused ? theme.selectedBg : undefined}>
              <Text bold={focused} color={focused ? theme.accent : theme.faint}>
                {focused ? "▸ " : "  "}
              </Text>
              <Text bold={focused} color={labelColor}>
                {item.label}
              </Text>
            </Text>
          </Text>
          <Box flexGrow={1} />
          {/* Always mounted; "" when not done (same Ink 5 quirk as above). */}
          <Text color={theme.ok}>{item.done ? "✓ done" : ""}</Text>
        </Box>
      </ClickableRow>,
    );

    if (focused) {
      // Clickable like the item row itself, and wrapping (not truncated) so
      // hints longer than the clamped box stay fully readable.
      rows.push(
        <ClickableRow
          key="hint"
          onClick={() => {
            if (!item.disabled) {
              onSelect(item.id);
            }
          }}
        >
          <Text color={theme.dim}>
            {"  "}
            {item.hint}
          </Text>
        </ClickableRow>,
      );
    }
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.border} wrap="truncate-end">
        {topLine}
      </Text>
      <Box
        borderColor={theme.border}
        borderStyle="round"
        borderTop={false}
        flexDirection="column"
        paddingX={1}
        width={boxWidth}
      >
        {rows}
      </Box>
      <Text color={theme.faint}>↑↓ or j/k move · enter select · q quit</Text>
    </Box>
  );
}

export type SelectItem = {
  id: string;
  label: string;
  hint: string;
};

type SelectListProps = {
  title: string;
  items: SelectItem[];
  onSelect: (id: string) => void;
  onCancel: () => void;
  isActive: boolean;
  initialId?: string;
  /** Fires with the highlighted id on every cursor move (not on mount) — used
   *  for live preview. Selecting/cancelling is still onSelect/onCancel. */
  onHighlight?: (id: string) => void;
};

/** Generic arrow-key picker (used for the PR template and theme pickers). */
export function SelectList({
  title,
  items,
  onSelect,
  onCancel,
  isActive,
  initialId,
  onHighlight,
}: SelectListProps) {
  const initialIndex = items.findIndex((item) => item.id === initialId);
  const [cursor, setCursor] = useState(initialIndex >= 0 ? initialIndex : 0);

  // Notify onHighlight on cursor moves for live preview. items/onHighlight are
  // read through refs so the effect depends only on the cursor — items is a
  // fresh array each render and would otherwise re-fire (or loop) every render.
  // The mount run is skipped so opening the picker doesn't re-apply the current
  // selection.
  const onHighlightRef = useRef(onHighlight);
  onHighlightRef.current = onHighlight;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const didMountRef = useRef(false);

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }

    const id = itemsRef.current[cursor]?.id;
    if (id !== undefined) {
      onHighlightRef.current?.(id);
    }
  }, [cursor]);

  useInput(
    (value, key) => {
      // k/j mirror the arrow keys for neovim-style navigation.
      if (key.upArrow || value === "k") {
        setCursor((current) => (current + items.length - 1) % items.length);
        return;
      }

      if (key.downArrow || value === "j") {
        setCursor((current) => (current + 1) % items.length);
        return;
      }

      if (key.return) {
        onSelect(items[cursor].id);
        return;
      }

      if (key.escape || value === "q") {
        onCancel();
      }
    },
    { isActive },
  );

  useOnWheel((direction) => {
    if (!isActive) {
      return;
    }

    setCursor((current) =>
      direction === "up"
        ? (current + items.length - 1) % items.length
        : (current + 1) % items.length,
    );
  });

  // Window the list to what fits under the logo/header. A list taller than the
  // viewport makes the alt-screen scroll, and Ink then can't erase the taller
  // frame when a shorter view redraws over it — leaving residue (a duplicated
  // logo). Keep the cursor centered in the window so it is always visible.
  const { columns, rows } = useTerminalSize();
  const logoRows = logoVisible(columns, rows) ? LOGO_LINES.length : 0;
  const visible = Math.max(3, rows - logoRows - SELECT_CHROME_ROWS);
  const maxStart = Math.max(0, items.length - visible);
  const start = Math.min(
    maxStart,
    Math.max(0, cursor - Math.floor(visible / 2)),
  );
  const windowItems = items.slice(start, start + visible);
  const above = start;
  const below = Math.max(0, items.length - (start + visible));

  return (
    <Box flexDirection="column">
      <Text color={theme.accent}>{title}</Text>
      <Box
        borderColor={theme.border}
        borderStyle="round"
        flexDirection="column"
        paddingX={1}
      >
        {/* Always-rendered scroll indicators (blank when at an end) keep the
            box a constant height as the window moves. */}
        <Text color={theme.dim}>{above > 0 ? `  ↑ ${above} more` : " "}</Text>
        {windowItems.map((item, offset) => {
          const index = start + offset;
          const focused = index === cursor;

          return (
            <ClickableRow key={item.id} onClick={() => onSelect(item.id)}>
              <Text wrap="truncate-end">
                <Text bold={focused} color={focused ? theme.accent : undefined}>
                  {focused ? "> " : "  "}
                  {item.label}
                </Text>
                {focused ? <Text color={theme.dim}> — {item.hint}</Text> : null}
              </Text>
            </ClickableRow>
          );
        })}
        <Text color={theme.dim}>{below > 0 ? `  ↓ ${below} more` : " "}</Text>
        <Text color={theme.dim}>
          ↑↓ or j/k to move · enter select · esc back
        </Text>
      </Box>
    </Box>
  );
}

type InlinePromptProps = {
  label: string;
  placeholder: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  isActive: boolean;
  /** When set, enter with an empty input submits "" (for optional fields). */
  allowEmpty?: boolean;
  /** Pre-filled input (read once on mount — remount with `key` to reseed). */
  initialValue?: string;
  /** Renders typed input as asterisks (for secrets); the real value is unaffected. */
  mask?: boolean;
};

/** Single-line bordered text prompt, matching the ChatApp input style. */
export function InlinePrompt({
  label,
  placeholder,
  onSubmit,
  onCancel,
  isActive,
  allowEmpty = false,
  initialValue = "",
  mask = false,
}: InlinePromptProps) {
  const [input, setInput] = useState(initialValue);
  const shown = mask ? "*".repeat(Math.min(input.length, 40)) : input;

  useInput(
    (value, key) => {
      if (key.escape) {
        onCancel();
        return;
      }

      if (key.return) {
        const trimmed = input.trim();

        if (trimmed.length > 0 || allowEmpty) {
          onSubmit(trimmed);
        }
        return;
      }

      // Only real backspace/delete erase; other special keys (arrows,
      // home/end, F-keys) arrive with an empty input and must be no-ops.
      if (key.backspace || key.delete) {
        setInput((current) => current.slice(0, -1));
        return;
      }

      if (value && !key.ctrl && !key.meta && !isMouseNoise(value)) {
        setInput((current) => current + value.replace(/[\r\n]/gu, ""));
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      {label ? <Text color={theme.accent}>{label}</Text> : null}
      <Box borderColor={theme.border} borderStyle="round" paddingX={1}>
        <Text>
          <Text color={theme.accentAlt}>{">"}</Text>{" "}
          {input.length > 0 ? (
            shown
          ) : (
            <Text color={theme.dim}>{placeholder}</Text>
          )}
        </Text>
      </Box>
      <Text color={theme.dim}>
        enter to submit{allowEmpty ? " (empty to skip)" : ""} — esc to go back
      </Text>
    </Box>
  );
}

type MultilinePromptProps = {
  label: string;
  placeholder: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  isActive: boolean;
  /** When set, ctrl+d with an empty input submits "" (for optional fields). */
  allowEmpty?: boolean;
  /** Pre-filled input (read once on mount — remount with `key` to reseed). */
  initialValue?: string;
  /** Rows shown in the box; older lines scroll out of view above. */
  visibleLines?: number;
};

/**
 * Multi-line bordered text prompt for long-form answers: enter inserts a
 * newline, ctrl+d submits, esc cancels. Pasted newlines are preserved
 * (terminals cannot distinguish shift+enter from enter, hence ctrl+d).
 */
export function MultilinePrompt({
  label,
  placeholder,
  onSubmit,
  onCancel,
  isActive,
  allowEmpty = false,
  initialValue = "",
  visibleLines = 6,
}: MultilinePromptProps) {
  const [input, setInput] = useState(initialValue);

  useInput(
    (value, key) => {
      if (key.escape) {
        onCancel();
        return;
      }

      if (key.ctrl && value === "d") {
        const trimmed = input.trim();

        if (trimmed.length > 0 || allowEmpty) {
          onSubmit(trimmed);
        }
        return;
      }

      if (key.return) {
        setInput((current) => `${current}\n`);
        return;
      }

      // Only real backspace/delete erase; other special keys (arrows,
      // home/end, F-keys) arrive with an empty input and must be no-ops.
      if (key.backspace || key.delete) {
        setInput(deleteLast);
        return;
      }

      if (value && !key.ctrl && !key.meta && !isMouseNoise(value)) {
        setInput((current) => appendInput(current, value));
      }
    },
    { isActive },
  );

  const { lines, hidden } = visibleTail(input, visibleLines);
  const lastIndex = lines.length - 1;

  return (
    <Box flexDirection="column">
      <Text color={theme.accent}>{label}</Text>
      <Box
        borderColor={theme.border}
        borderStyle="round"
        flexDirection="column"
        paddingX={1}
      >
        {hidden > 0 ? (
          <Text color={theme.dim}>
            … {hidden} more line{hidden === 1 ? "" : "s"} above
          </Text>
        ) : null}
        {input.length === 0 ? (
          <Text>
            <Text inverse> </Text> <Text color={theme.dim}>{placeholder}</Text>
          </Text>
        ) : (
          lines.map((line, index) => (
            <Text key={index}>
              {line}
              {index === lastIndex ? <Text inverse> </Text> : null}
            </Text>
          ))
        )}
      </Box>
      <Text color={theme.dim}>
        enter for new line — ctrl+d to save
        {allowEmpty ? " (empty to skip)" : ""} — esc to go back
      </Text>
    </Box>
  );
}
