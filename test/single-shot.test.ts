import { describe, expect, it } from "vitest";
import { stripMarkdownFence, stripPreamble } from "../src/llm/single-shot.js";

const DOC = "# Implement retries\n\n## Objective\n\nRetry failed uploads.";

describe("stripMarkdownFence", () => {
  it("unwraps one whole-document fence and leaves plain text alone", () => {
    expect(stripMarkdownFence(`\`\`\`markdown\n${DOC}\n\`\`\``)).toBe(DOC);
    expect(stripMarkdownFence(`\n${DOC}\n`)).toBe(DOC);
  });

  it("leaves a fence that only covers part of the document alone", () => {
    const withCodeBlock = `${DOC}\n\n\`\`\`ts\nconst a = 1;\n\`\`\`\n\nDone.`;

    expect(stripMarkdownFence(withCodeBlock)).toBe(withCodeBlock);
  });
});

describe("stripPreamble", () => {
  const SECTIONS =
    "## Objective & users\n\nRetry failed uploads.\n\n## Assumptions\n\n- None.";

  it("drops the narration an agentic CLI writes before the first section", () => {
    expect(
      stripPreamble(
        `Now I have a thorough understanding of the codebase. Let me write the requirements document.\n\n${SECTIONS}`,
      ),
    ).toBe(SECTIONS);
  });

  it("drops a lead-in before a fenced document so the fence can be unwrapped", () => {
    const fenced = `\`\`\`markdown\n${SECTIONS}\n\`\`\``;

    expect(
      stripMarkdownFence(stripPreamble(`Here is the document:\n${fenced}`)),
    ).toBe(SECTIONS);
  });

  it("keeps a document that already opens with a heading or has no section", () => {
    expect(stripPreamble(`\n${SECTIONS}\n`)).toBe(SECTIONS);
    expect(stripPreamble("Just prose, no sections.")).toBe(
      "Just prose, no sections.",
    );
  });

  it("keeps a long lead-in: past the limit it is content, not chatter", () => {
    const long = `${"word ".repeat(200)}\n\n${SECTIONS}`;

    expect(stripPreamble(long)).toBe(long.trim());
  });
});

describe("stripPreamble with the document's first section", () => {
  const SECTIONS =
    "## Objective & users\n\nRetry failed uploads.\n\n## Assumptions\n\n- None.";

  it("drops a long synthesis before the expected first section", () => {
    const synthesis = [
      "Now I have enough context to write the requirements document. Let me synthesize what I've learned:",
      ...Array.from(
        { length: 12 },
        (_, index) => `- **Finding ${index}**: ${"detail ".repeat(10)}`,
      ),
      "",
    ].join("\n");

    expect(
      stripPreamble(`${synthesis}\n${SECTIONS}`, "Objective & users"),
    ).toBe(SECTIONS);
  });

  it("keeps the fence opened right above the section so it can be unwrapped", () => {
    expect(
      stripMarkdownFence(
        stripPreamble(
          `Here it is:\n\`\`\`markdown\n${SECTIONS}\n\`\`\``,
          "Objective & users",
        ),
      ),
    ).toBe(SECTIONS);
  });

  it("falls back to the short lead-in rule when the section is missing", () => {
    expect(stripPreamble(`Done reading.\n\n${SECTIONS}`, "Overview")).toBe(
      SECTIONS,
    );
  });
});

describe("stripPreamble never drops real sections", () => {
  it("keeps a reordered document whole instead of cutting at the first section", () => {
    const reordered =
      "## Assumptions\n\n- One owner.\n\n## Objective & users\n\nAlerts.";

    expect(stripPreamble(reordered, "Objective & users")).toBe(reordered);
    expect(
      stripPreamble(`Done reading.\n\n${reordered}`, "Objective & users"),
    ).toBe(reordered);
  });

  it("unwraps a fence with a blank line or a capitalised language tag", () => {
    const sections = "## Overview\n\nThe approach.";

    expect(
      stripMarkdownFence(
        stripPreamble(
          `Here:\n\`\`\`markdown\n\n${sections}\n\`\`\``,
          "Overview",
        ),
      ),
    ).toBe(sections);
    expect(
      stripMarkdownFence(
        stripPreamble(
          `Here:\n\`\`\`Markdown\r\n${sections}\r\n\`\`\``,
          "Overview",
        ),
      ),
    ).toBe(sections.replace(/\n/gu, "\n"));
  });
});
