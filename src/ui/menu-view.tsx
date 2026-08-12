import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import { MENU_PANEL_TITLE } from "./branding.js";
import {
  MENU_ITEMS,
  type MenuChoice,
  type MenuDetail,
  type MenuItem,
} from "./menu-items.js";
import { useOnClick, useOnWheel } from "./mouse.js";
import {
  caretSplit,
  handleEditingKey,
  insertAt,
  makeEditorState,
  maskedView,
} from "./editor.js";
import { Panel } from "./panel.js";
import { visibleRowWindow, visibleSlice, wrapLines } from "./text-buffer.js";
import { theme } from "./theme.js";
import { useTextInput } from "./use-text-input.js";
import {
  computePromptRows,
  useViewport,
  WIDE_LAYOUT_COLUMNS,
} from "./viewport.js";

/**
 * Rows the SelectList adds around its item window beyond the shared
 * logo/header chrome (already subtracted by useViewport's contentRows): the
 * picker title, the box's two borders, its two scroll indicators, and the
 * footer hint, minus the viewport cushion.
 */
const SELECT_EXTRA_ROWS = 4;

/** Item rows the list keeps even when the viewport says there is no room. */
const SELECT_MIN_ROWS = 3;

/** Columns the bordered box spends on its borders and horizontal padding. */
const BOX_CHROME_COLUMNS = 4;

/** Rendered and measured from one place so the wrap math can't drift. */
const SELECT_FOOTER = "↑↓ or j/k to move · enter select · esc back";

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

/** Rows the wide layout's side panel spends on its heading and blank rule. */
const DETAIL_HEADING_ROWS = 2;

type MainMenuProps = {
  onSelect: (choice: MenuChoice) => void;
  isActive: boolean;
  items?: MenuItem[];
  /** Repository context shown beside the list on a wide terminal (ignored
   *  when narrow — there the header line already carries it). */
  detail?: MenuDetail[];
};

/** Arrow-key select menu (replaces the free-text chat input). */
export function MainMenu({
  onSelect,
  isActive,
  items = MENU_ITEMS,
  detail = [],
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

  const { contentColumns, contentRows } = useViewport();
  // Clamp between a readable minimum and the classic 62-column cap, while
  // leaving one spare column on each side of narrow terminals.
  const boxWidth = Math.max(30, Math.min(62, contentColumns - 2));
  // 2 border columns + paddingX 1 on each side.
  const innerWidth = Math.max(0, boxWidth - 4);
  // Past the breakpoint the list keeps its readable 62 columns and the space
  // beside it becomes a detail panel, instead of staying empty. The pane's
  // width is computed rather than left to flexGrow: the hint is wrapped to it
  // by hand, and wrapping to a width Yoga then disagrees with would miscount
  // the rows this frame costs.
  const detailWidth = contentColumns - boxWidth - 2;
  const wide = contentColumns >= WIDE_LAYOUT_COLUMNS && detailWidth >= 24;

  const rows: ReactNode[] = [];
  let cursorRow = 0;
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

    if (focused) {
      cursorRow = rows.length;
    }
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

    // Wide layout shows the hint in the side panel instead, which frees the
    // row it costs here (and never truncates a long one).
    if (focused && !wide) {
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

  // Window the menu rows only when they cannot fit: a frame taller than the
  // terminal scrolls the alt screen and leaves redraw residue. The budget
  // leaves room for the panel borders, the footer, the focused item's
  // wrapping hint row (wide layout has none — that row is reclaimed), and the
  // two overflow-indicator rows; the window stays centered on the cursor.
  const maxMenuRows = Math.max(4, contentRows - (wide ? 5 : 6));
  let shownRows = rows;
  let hiddenAbove = 0;
  let hiddenBelow = 0;

  if (rows.length > maxMenuRows) {
    const start = Math.min(
      rows.length - maxMenuRows,
      Math.max(0, cursorRow - Math.floor(maxMenuRows / 2)),
    );

    shownRows = rows.slice(start, start + maxMenuRows);
    hiddenAbove = start;
    hiddenBelow = rows.length - (start + maxMenuRows);
  }

  const list = (
    <Panel title={MENU_PANEL_TITLE} width={boxWidth}>
      {hiddenAbove > 0 ? (
        <Text color={theme.dim}>{`  ↑ ${hiddenAbove} more`}</Text>
      ) : null}
      {shownRows}
      {hiddenBelow > 0 ? (
        <Text color={theme.dim}>{`  ↓ ${hiddenBelow} more`}</Text>
      ) : null}
    </Panel>
  );
  const footer = (
    <Text color={theme.faint}>↑↓ or j/k move · enter select · q quit</Text>
  );

  if (!wide) {
    return (
      <Box flexDirection="column">
        {list}
        {footer}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box columnGap={2} flexDirection="row">
        <Box flexShrink={0}>{list}</Box>
        <MenuDetailPane
          detail={detail}
          item={items[cursor]}
          maxRows={maxMenuRows}
          width={detailWidth}
        />
      </Box>
      {footer}
    </Box>
  );
}

/**
 * The wide layout's right-hand column: the focused action's full hint plus the
 * repository context the header otherwise crams into one truncated line.
 * Bounded to the same row budget as the list so this column can never be the
 * one that pushes the frame past the terminal's height.
 */
function MenuDetailPane({
  item,
  detail,
  width,
  maxRows,
}: {
  item: MenuItem | undefined;
  detail: MenuDetail[];
  width: number;
  maxRows: number;
}) {
  // Two borders and one column of padding on each side.
  const inner = Math.max(10, width - 4);
  const hintRows = item ? wrapLines(item.hint, inner) : [];
  const budget = Math.max(1, maxRows - DETAIL_HEADING_ROWS - detail.length);

  return (
    <Panel title="Details" width={width}>
      <Text bold color={theme.accent} wrap="truncate-end">
        {item?.label ?? ""}
      </Text>
      {hintRows.slice(0, budget).map((row, index) => (
        <Text color={theme.dim} key={index} wrap="truncate-end">
          {row.length > 0 ? row : " "}
        </Text>
      ))}
      <Text> </Text>
      {detail.map((row) => (
        <Text key={row.label} wrap="truncate-end">
          <Text color={theme.dim}>{row.label} </Text>
          <Text color={theme.body}>{row.value}</Text>
        </Text>
      ))}
    </Panel>
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
  // SELECT_EXTRA_ROWS budgets one row each for the title and the footer, which
  // a narrow terminal breaks: both wrap, and the rows they gain are rows the
  // frame grows past the viewport. Charge the item window for the wrapped
  // lines — and where the viewport is too short to pay, drop the footer (a
  // hint about the standard keys) rather than overflow.
  const { contentColumns, contentRows } = useViewport();
  const footerRows = wrapLines(
    SELECT_FOOTER,
    Math.max(1, contentColumns - BOX_CHROME_COLUMNS),
  ).length;
  const wrappedRows =
    wrapLines(title, contentColumns).length - 1 + (footerRows - 1);
  const budget = contentRows - SELECT_EXTRA_ROWS - wrappedRows;
  const showFooter = budget >= SELECT_MIN_ROWS;
  const visible = Math.max(
    SELECT_MIN_ROWS,
    showFooter ? budget : budget + footerRows,
  );
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
        {showFooter ? <Text color={theme.dim}>{SELECT_FOOTER}</Text> : null}
      </Box>
    </Box>
  );
}

type MultiSelectListProps = {
  title: string;
  items: SelectItem[];
  /** Ids checked on mount (read once — remount with `key` to reseed). */
  initialSelected?: string[];
  /** Fires with the checked ids, in `items` order. */
  onConfirm: (ids: string[]) => void;
  onCancel: () => void;
  isActive: boolean;
};

/**
 * Checkbox list — SelectList's sibling for "pick several". Space toggles the
 * focused row (so does a click), "a" toggles every row, enter confirms, esc
 * cancels. The window math is SelectList's, unchanged: a list taller than the
 * viewport makes the alt screen scroll and leaves redraw residue behind a
 * shorter view.
 */
export function MultiSelectList({
  title,
  items,
  initialSelected,
  onConfirm,
  onCancel,
  isActive,
}: MultiSelectListProps) {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelected ?? items.map((item) => item.id)),
  );

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);

      if (!next.delete(id)) {
        next.add(id);
      }

      return next;
    });
  }

  useInput(
    (value, key) => {
      if (key.upArrow || value === "k") {
        setCursor((current) => (current + items.length - 1) % items.length);
        return;
      }

      if (key.downArrow || value === "j") {
        setCursor((current) => (current + 1) % items.length);
        return;
      }

      if (value === " ") {
        toggle(items[cursor].id);
        return;
      }

      if (value === "a") {
        setSelected((current) =>
          current.size === items.length
            ? new Set()
            : new Set(items.map((item) => item.id)),
        );
        return;
      }

      if (key.return) {
        onConfirm(
          items.filter((item) => selected.has(item.id)).map((i) => i.id),
        );
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

  const { contentRows } = useViewport();
  // One row more chrome than SelectList: the count line above the hint.
  const visible = Math.max(3, contentRows - SELECT_EXTRA_ROWS - 1);
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
        <Text color={theme.dim}>{above > 0 ? `  ↑ ${above} more` : " "}</Text>
        {windowItems.map((item, offset) => {
          const index = start + offset;
          const focused = index === cursor;
          const checked = selected.has(item.id);

          return (
            <ClickableRow key={item.id} onClick={() => toggle(item.id)}>
              {/* One stable child list; only props and text content change
                  between renders — toggling a middle child of a <Text> between
                  null and a node corrupts Ink 5's reconciliation. */}
              <Text wrap="truncate-end">
                <Text color={focused ? theme.accent : theme.faint}>
                  {focused ? "> " : "  "}
                </Text>
                <Text color={checked ? theme.ok : theme.dim}>
                  {checked ? "[x] " : "[ ] "}
                </Text>
                <Text bold={focused} color={checked ? theme.body : theme.dim}>
                  {item.label}
                </Text>
                <Text color={theme.dim}>
                  {focused && item.hint.length > 0 ? ` — ${item.hint}` : ""}
                </Text>
              </Text>
            </ClickableRow>
          );
        })}
        <Text color={theme.dim}>{below > 0 ? `  ↓ ${below} more` : " "}</Text>
        <Text color={theme.faint}>
          {selected.size} of {items.length} selected
        </Text>
        <Text color={theme.dim}>
          space toggles · a all/none · enter confirm · esc back
        </Text>
      </Box>
    </Box>
  );
}

type PreviewPaneProps = {
  title: string;
  text: string;
  /** When true, grows to fill the remaining width in a side-by-side row. */
  grow?: boolean;
};

/**
 * Bordered, height-capped panel that previews a block of text beside a
 * SelectList (the PR template picker uses it to show a template's shape). Shows
 * the head of the text — templates lead with their key sections — truncating
 * long lines to the pane width and footing with a "… N more lines" count. Its
 * height tracks the same viewport math as SelectList so the two panes stay
 * roughly aligned.
 */
export function PreviewPane({ title, text, grow }: PreviewPaneProps) {
  const { contentRows } = useViewport();
  const cap = Math.max(6, contentRows - SELECT_EXTRA_ROWS);
  const lines = text.split("\n");
  const shown = lines.slice(0, cap);
  const hidden = lines.length - shown.length;

  return (
    <Box flexDirection="column" flexGrow={grow ? 1 : undefined}>
      <Text color={theme.accent}>{title}</Text>
      <Box
        borderColor={theme.border}
        borderStyle="round"
        flexDirection="column"
        paddingX={1}
      >
        {shown.map((line, index) => (
          <Text color={theme.dim} key={index} wrap="truncate-end">
            {line.length > 0 ? line : " "}
          </Text>
        ))}
        <Text color={theme.faint}>
          {hidden > 0 ? `… ${hidden} more line${hidden === 1 ? "" : "s"}` : " "}
        </Text>
      </Box>
    </Box>
  );
}

/** Rows a ScrollView adds around its window beyond the shared logo/header
 *  chrome (already in useViewport's contentRows): this view's title and two
 *  scroll indicators, plus a small cushion — over-tall alt-screen frames
 *  leave redraw residue, so fewer rows is always the safer direction. */
const SCROLL_EXTRA_ROWS = 4;

/** Wheel notches move a few rows at a time; keys move one row / one page. */
const SCROLL_WHEEL_STEP = 3;

type ScrollViewProps = {
  title: string;
  text: string;
  onExit: () => void;
  isActive: boolean;
};

/**
 * Full-width scrollable reader for long generated output (PR descriptions,
 * agent prompts) so the whole text can be reviewed, not just its tail. The text
 * is pre-wrapped to the terminal width so every row is one visual line, then
 * windowed to what fits under the logo/header. j/k or arrows scroll one row,
 * PageUp/PageDown a page, g/G jump to the ends, the wheel scrolls, and esc/q
 * exits. Mirrors HelpView so the two scroll experiences feel identical.
 */
export function ScrollView({ title, text, onExit, isActive }: ScrollViewProps) {
  const { contentColumns, contentRows } = useViewport();
  const [offset, setOffset] = useState(0);

  const width = Math.max(20, contentColumns - 2);
  const lines = useMemo(() => wrapLines(text, width), [text, width]);

  const visible = Math.max(4, contentRows - SCROLL_EXTRA_ROWS);

  const maxOffset = Math.max(0, lines.length - visible);
  const clamped = Math.min(offset, maxOffset);
  const window = lines.slice(clamped, clamped + visible);
  const above = clamped;
  const below = Math.max(0, lines.length - (clamped + visible));

  function scrollBy(delta: number) {
    setOffset((current) => Math.min(maxOffset, Math.max(0, current + delta)));
  }

  useInput(
    (value, key) => {
      if (key.escape || value === "q") {
        onExit();
        return;
      }

      if (key.upArrow || value === "k") {
        scrollBy(-1);
        return;
      }

      if (key.downArrow || value === "j") {
        scrollBy(1);
        return;
      }

      if (key.pageUp || value === "b") {
        scrollBy(-visible);
        return;
      }

      if (key.pageDown || value === "f" || value === " ") {
        scrollBy(visible);
        return;
      }

      if (value === "g") {
        setOffset(0);
        return;
      }

      if (value === "G") {
        setOffset(maxOffset);
      }
    },
    { isActive },
  );

  useOnWheel((direction) => {
    if (!isActive) {
      return;
    }

    scrollBy(direction === "up" ? -SCROLL_WHEEL_STEP : SCROLL_WHEEL_STEP);
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.accent}>{title}</Text>
      <Text color={theme.dim}>
        {above > 0
          ? `↑ ${above} more line${above === 1 ? "" : "s"} above`
          : " "}
      </Text>
      <Box flexDirection="column">
        {window.map((line, index) => (
          // Pre-wrapped rows already fit; truncate-end guards any off-by-one so
          // each row stays a single visual line and the scroll math holds.
          <Text key={index} wrap="truncate-end">
            {line === "" ? " " : line}
          </Text>
        ))}
      </Box>
      <Text color={theme.dim}>
        {below > 0
          ? `↓ ${below} more — ↑/↓ or j/k · wheel · PgUp/PgDn · g/G · esc back`
          : "end — ↑/↓ or j/k · wheel to scroll · esc to go back"}
      </Text>
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
  const { contentColumns } = useViewport();
  const [state, setState] = useState(() => makeEditorState(initialValue));
  // Scroll offset of the horizontal window (see MultilinePrompt's startRef).
  const startRef = useRef(Infinity);

  useTextInput(
    (value, key, pasted) => {
      if (key.escape) {
        onCancel();
        return;
      }

      if (key.return) {
        const trimmed = state.text.trim();

        if (trimmed.length > 0 || allowEmpty) {
          onSubmit(trimmed);
        }
        return;
      }

      if (pasted) {
        setState((current) => insertAt(current, value, false));
        return;
      }

      setState(
        (current) =>
          handleEditingKey(current, value, key, { multiline: false }).state,
      );
    },
    { isActive },
  );

  // Columns the value may draw in: the box's two borders and paddingX, the
  // "> " prefix, and the caret cell (which sits past the text when appending).
  const textWidth = Math.max(8, contentColumns - 6);
  const length = Array.from(state.text).length;
  // Once the value outgrows the box it scrolls sideways, and the two edge
  // markers get a reserved column each so the row's width never changes.
  const scrolls = length >= textWidth;
  const view = visibleSlice(
    state.text,
    state.cursor,
    scrolls ? Math.max(4, textWidth - 2) : textWidth,
    startRef.current,
  );

  startRef.current = view.hiddenLeft;

  const masked = mask
    ? maskedView(length, state.cursor, Math.max(4, textWidth - 1))
    : null;
  const split = caretSplit(view.text, view.cursorCol);

  return (
    <Box flexDirection="column">
      {label ? <Text color={theme.accent}>{label}</Text> : null}
      <Box borderColor={theme.border} borderStyle="round" paddingX={1}>
        <Text wrap="truncate-end">
          <Text color={theme.accentAlt}>{">"}</Text>{" "}
          {state.text.length === 0 ? (
            <Text>
              <Text inverse> </Text>{" "}
              <Text color={theme.dim}>{placeholder}</Text>
            </Text>
          ) : masked ? (
            <Text>
              {"*".repeat(masked.before)}
              <Text inverse>{masked.at}</Text>
              {"*".repeat(masked.after)}
            </Text>
          ) : (
            <Text>
              <Text color={theme.dim}>
                {scrolls ? (view.hiddenLeft > 0 ? "…" : " ") : ""}
              </Text>
              {split.before}
              <Text inverse>{split.at}</Text>
              {split.after}
              <Text color={theme.dim}>
                {scrolls ? (view.hiddenRight > 0 ? "…" : " ") : ""}
              </Text>
            </Text>
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
  /** Caps the rows shown in the box; by default only the viewport caps them. */
  visibleLines?: number;
};

/** Smallest usable text area; below this the box sheds its hint row instead. */
const MIN_PROMPT_ROWS = 2;
/**
 * Ceiling on the text area however tall the terminal is: every row here is a
 * row the surrounding view cannot use, and a very tall box scrolls more than
 * it shows.
 */
const MAX_PROMPT_ROWS = 20;

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
  visibleLines,
}: MultilinePromptProps) {
  const { contentColumns, contentRows } = useViewport();
  const [state, setState] = useState(() => makeEditorState(initialValue));
  // Scroll offset of the cursor-following window; Infinity = bottom-anchored
  // until the first render computes a real start. A ref (not state): it is
  // derived from text/cursor during render and must not trigger re-renders.
  const startRef = useRef(Infinity);

  useTextInput(
    (value, key, pasted) => {
      if (key.escape) {
        onCancel();
        return;
      }

      if (key.ctrl && value === "d") {
        const trimmed = state.text.trim();

        if (trimmed.length > 0 || allowEmpty) {
          onSubmit(trimmed);
        }
        return;
      }

      if (pasted) {
        setState((current) => insertAt(current, value, true));
        return;
      }

      if (key.return) {
        setState((current) => insertAt(current, "\n", true));
        return;
      }

      setState(
        (current) =>
          handleEditingKey(current, value, key, { multiline: true }).state,
      );
    },
    { isActive },
  );

  const hint = `enter for new line — ctrl+d to save${
    allowEmpty ? " (empty to skip)" : ""
  } — esc to go back`;
  // The label and hint are full-width text that wraps, so they are measured,
  // not assumed: a 97-character label costs two rows at 80 columns and three
  // at 60. Plus the box's two borders and the one scroll-indicator row the
  // window can add.
  const labelRows = wrapLines(label, contentColumns).length;
  const hintRows = wrapLines(hint, contentColumns).length;
  const fixedRows = labelRows + 3;
  // On a terminal too short for both, the hint is what goes: an unusable
  // one-row text area helps nobody, and an over-tall frame is worse than a
  // missing hint.
  const showHint = contentRows - fixedRows - hintRows >= MIN_PROMPT_ROWS;
  const rows = computePromptRows(
    contentRows,
    fixedRows + (showHint ? hintRows : 0),
    { min: MIN_PROMPT_ROWS, max: visibleLines ?? MAX_PROMPT_ROWS },
  );
  // Two borders, two columns of padding, and the caret cell past the text.
  const width = Math.max(8, contentColumns - 5);

  let view = visibleRowWindow(
    state.text,
    state.cursor,
    width,
    rows,
    startRef.current,
  );

  // When both scroll indicators would show at once, give up one content row
  // instead of growing the frame — over-tall Ink frames redraw glitchily.
  if (view.hiddenAbove > 0 && view.hiddenBelow > 0 && rows > 1) {
    view = visibleRowWindow(
      state.text,
      state.cursor,
      width,
      rows - 1,
      startRef.current,
    );
  }

  startRef.current = view.start;

  return (
    <Box flexDirection="column">
      <Text color={theme.accent}>{label}</Text>
      <Box
        borderColor={theme.border}
        borderStyle="round"
        flexDirection="column"
        paddingX={1}
      >
        {view.hiddenAbove > 0 ? (
          <Text color={theme.dim} wrap="truncate-end">
            … {view.hiddenAbove} more row{view.hiddenAbove === 1 ? "" : "s"}{" "}
            above
          </Text>
        ) : null}
        {state.text.length === 0 ? (
          <Text wrap="truncate-end">
            <Text inverse> </Text> <Text color={theme.dim}>{placeholder}</Text>
          </Text>
        ) : (
          // Pre-wrapped rows already fit; truncate-end guards the one case the
          // code-point width cannot see (a double-width glyph) from adding a
          // visual row the budget did not account for.
          view.rows.map((row, index) => {
            if (index !== view.cursorRow) {
              // A bare empty <Text> collapses to zero height; keep the row.
              return (
                <Text key={index} wrap="truncate-end">
                  {row === "" ? " " : row}
                </Text>
              );
            }

            const split = caretSplit(row, view.cursorCol);

            return (
              <Text key={index} wrap="truncate-end">
                {split.before}
                <Text inverse>{split.at}</Text>
                {split.after}
              </Text>
            );
          })
        )}
        {view.hiddenBelow > 0 ? (
          <Text color={theme.dim} wrap="truncate-end">
            … {view.hiddenBelow} more row{view.hiddenBelow === 1 ? "" : "s"}{" "}
            below
          </Text>
        ) : null}
      </Box>
      {showHint ? <Text color={theme.dim}>{hint}</Text> : null}
    </Box>
  );
}
