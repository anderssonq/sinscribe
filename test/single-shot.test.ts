import { describe, expect, it } from "vitest";
import { stripMarkdownFence } from "../src/llm/single-shot.js";

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
