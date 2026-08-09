import type { ReactNode } from "react";
import { Box } from "ink";
import { useViewport } from "./viewport.js";

/**
 * The frame every root renders inside: a content column of at most
 * `contentColumns`, centered by `gutter`. Each root used to be a bare
 * full-width `<Box flexDirection="column">`, which on a wide terminal left the
 * menu marooned at the left edge and wrapped prose at the full terminal width.
 *
 * The offset is a real Yoga margin, never padded strings: mouse hit-testing
 * (mouse.tsx's resolveRect) resolves a node's position by summing
 * getComputedLeft() up the tree, which includes this margin, so clicks stay
 * aligned. justifyContent="center" would instead make Yoga measure and center
 * each child on its own, giving a ragged left edge.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { contentColumns, gutter } = useViewport();

  return (
    <Box flexDirection="column" marginLeft={gutter} width={contentColumns}>
      {children}
    </Box>
  );
}
