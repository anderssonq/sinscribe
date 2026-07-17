import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { measureElement, useStdin, type DOMElement } from "ink";
import {
  hitTest,
  parseSgrMouse,
  type MouseEvent,
  type Rect,
} from "./mouse-protocol.js";
import { DISABLE_MOUSE, ENABLE_MOUSE, markActive } from "./term.js";

/**
 * Mouse support for the alt-screen menu. MouseProvider enables terminal
 * mouse reporting only while `active` (picker views), so text prompts never
 * see mouse noise and terminal text selection keeps working everywhere else.
 * Hit-testing relies on the alt screen pinning ink-root at terminal (1,1).
 */

type WheelDirection = "up" | "down";

type ClickRegion = {
  node: DOMElement | null;
  onClick: () => void;
};

type MouseContextValue = {
  registerClick: (region: ClickRegion) => () => void;
  registerWheel: (handler: (direction: WheelDirection) => void) => () => void;
};

const MouseContext = createContext<MouseContextValue | null>(null);

/**
 * A node's rect in ink-root coordinates, resolved lazily at click time
 * (resilient to re-renders and resizes) by summing yoga offsets up the tree.
 */
function resolveRect(node: DOMElement | null): Rect | null {
  if (node === null || node.yogaNode === undefined) {
    return null;
  }

  let left = 0;
  let top = 0;
  let current: DOMElement | undefined = node;

  while (current !== undefined && current.yogaNode !== undefined) {
    left += current.yogaNode.getComputedLeft();
    top += current.yogaNode.getComputedTop();
    current = current.parentNode;
  }

  const { width, height } = measureElement(node);

  return { left, top, width, height };
}

export function MouseProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const clickRegions = useRef(new Set<ClickRegion>());
  const wheelHandlers = useRef(new Set<(direction: WheelDirection) => void>());
  const restRef = useRef("");
  const { stdin } = useStdin();

  const contextValue = useRef<MouseContextValue>({
    registerClick: (region) => {
      clickRegions.current.add(region);

      return () => {
        clickRegions.current.delete(region);
      };
    },
    registerWheel: (handler) => {
      wheelHandlers.current.add(handler);

      return () => {
        wheelHandlers.current.delete(handler);
      };
    },
  });

  useEffect(() => {
    if (!active || !process.stdout.isTTY) {
      return;
    }

    const dispatch = (event: MouseEvent) => {
      if (event.kind === "wheel") {
        for (const handler of wheelHandlers.current) {
          handler(event.direction);
        }
        return;
      }

      // Click = left-button press; releases and other buttons are ignored.
      if (event.kind !== "press" || event.button !== 0) {
        return;
      }

      for (const region of clickRegions.current) {
        const rect = resolveRect(region.node);

        if (rect !== null && hitTest(rect, event.x, event.y)) {
          region.onClick();
          return;
        }
      }
    };

    // Direct stdin listener: Node multicasts data events, so Ink's own
    // keyboard handling is unaffected (it sees mouse bytes as ignorable
    // text — see isMouseNoise in editor.ts for the prompt-side guard).
    const onData = (data: Buffer | string) => {
      const { events, rest } = parseSgrMouse(restRef.current + String(data));

      restRef.current = rest;
      for (const event of events) {
        dispatch(event);
      }
    };

    process.stdout.write(ENABLE_MOUSE);
    markActive("mouse", true);
    stdin.on("data", onData);

    return () => {
      stdin.off("data", onData);
      process.stdout.write(DISABLE_MOUSE);
      markActive("mouse", false);
      restRef.current = "";
    };
  }, [active, stdin]);

  return (
    <MouseContext.Provider value={contextValue.current}>
      {children}
    </MouseContext.Provider>
  );
}

/**
 * Returns a ref callback to attach to a Box; onClick fires on a left-button
 * press inside it. No-op when rendered outside a MouseProvider.
 */
export function useOnClick(
  onClick: () => void,
): (node: DOMElement | null) => void {
  const context = useContext(MouseContext);
  const regionRef = useRef<ClickRegion>({ node: null, onClick });

  regionRef.current.onClick = onClick;

  useEffect(() => {
    if (context === null) {
      return;
    }

    return context.registerClick(regionRef.current);
  }, [context]);

  return useCallback((node: DOMElement | null) => {
    regionRef.current.node = node;
  }, []);
}

/** Subscribes to wheel events while mounted under a MouseProvider. */
export function useOnWheel(onWheel: (direction: WheelDirection) => void): void {
  const context = useContext(MouseContext);
  const handlerRef = useRef(onWheel);

  handlerRef.current = onWheel;

  useEffect(() => {
    if (context === null) {
      return;
    }

    return context.registerWheel((direction) => {
      handlerRef.current(direction);
    });
  }, [context]);
}
