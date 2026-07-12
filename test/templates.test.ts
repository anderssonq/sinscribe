import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getLlmPlaceholderNames,
  renderTemplate,
  renderTemplatePreview,
} from "../src/templates/render.js";
import { parseTemplate, TemplateParseError } from "../src/templates/schema.js";

const SAMPLE = `---
name: sample
kind: pr
description: test template
placeholders:
  title: { type: string, required: true, from: llm }
  changes: { type: list, required: true, from: llm }
  notes: { type: markdown, required: false, from: llm }
  branch: { type: string, required: true, from: git }
---
## {{title}}

Branch: {{branch}}

{{changes}}

{{notes}}
`;

describe("parseTemplate", () => {
  it("parses frontmatter and body", () => {
    const template = parseTemplate(SAMPLE, "sample.md");

    expect(template.name).toBe("sample");
    expect(template.kind).toBe("pr");
    expect(template.placeholders.title.from).toBe("llm");
    expect(template.placeholders.branch.from).toBe("git");
    expect(getLlmPlaceholderNames(template)).toEqual([
      "title",
      "changes",
      "notes",
    ]);
  });

  it("rejects missing frontmatter and bad kinds", () => {
    expect(() => parseTemplate("no frontmatter", "x.md")).toThrow(
      TemplateParseError,
    );
    expect(() =>
      parseTemplate("---\nname: x\nkind: nope\n---\nbody", "x.md"),
    ).toThrow(TemplateParseError);
  });
});

describe("renderTemplate", () => {
  const template = parseTemplate(SAMPLE, "sample.md");

  it("substitutes values and renders lists as bullets", () => {
    const rendered = renderTemplate(template, {
      title: "Add retries",
      branch: "feat/retries",
      changes: ["retry uploader", "add backoff"],
      notes: undefined,
    });

    expect(rendered).toContain("## Add retries");
    expect(rendered).toContain("- retry uploader\n- add backoff");
    expect(rendered).not.toContain("{{");
  });

  it("throws on missing required values", () => {
    expect(() => renderTemplate(template, { title: "x" })).toThrow(
      /Missing required placeholder/u,
    );
  });

  it("leaves slots unfilled for dry runs", () => {
    const rendered = renderTemplate(
      template,
      { branch: "feat/retries" },
      { leaveUnfilled: true },
    );

    expect(rendered).toContain("{{title}}");
    expect(rendered).toContain("feat/retries");
  });
});

describe("renderTemplatePreview", () => {
  it("replaces every slot with a hint and leaves no {{ syntax", () => {
    const template = parseTemplate(SAMPLE, "sample.md");
    const preview = renderTemplatePreview(template);

    expect(preview).not.toContain("{{");
    // No descriptions on SAMPLE's placeholders → hint falls back to the name.
    expect(preview).toContain("‹ title ›");
    expect(preview).toContain("‹ changes ›");
    // Static body text is preserved so the shape reads like the real output.
    expect(preview).toContain("Branch: ‹ branch ›");
  });

  it("uses the placeholder description as the hint when present", () => {
    const template = parseTemplate(
      `---
name: described
kind: pr
placeholders:
  summary:
    type: markdown
    required: true
    from: llm
    description: Summary of the change
---
## Summary

{{summary}}
`,
      "described.md",
    );

    expect(renderTemplatePreview(template)).toContain(
      "‹ Summary of the change ›",
    );
  });
});

describe("shipped templates", () => {
  const dir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "templates",
  );

  it("ships exactly the six predefined PR templates", async () => {
    const files = (await readdir(dir)).filter((file) => file.endsWith(".md"));

    expect(files.map((file) => file.replace(/\.md$/u, "")).sort()).toEqual([
      "andersoftware",
      "github",
      "google",
      "kubernetes",
      "shopify",
      "stripe",
    ]);
  });

  it("all parse and are pr templates", async () => {
    const files = (await readdir(dir)).filter((file) => file.endsWith(".md"));

    for (const file of files) {
      const template = parseTemplate(
        await readFile(path.join(dir, file), "utf8"),
        file,
      );

      expect(template.kind).toBe("pr");
      expect(getLlmPlaceholderNames(template).length).toBeGreaterThan(0);
    }
  });

  it("andersoftware exposes the required LLM slots", async () => {
    const template = parseTemplate(
      await readFile(path.join(dir, "andersoftware.md"), "utf8"),
      "andersoftware.md",
    );
    const llmSlots = getLlmPlaceholderNames(template);

    for (const slot of [
      "title",
      "summary",
      "changes",
      "motivation",
      "testing",
    ]) {
      expect(llmSlots).toContain(slot);
      expect(template.placeholders[slot].required).toBe(true);
    }

    for (const slot of [
      "screenshots_section",
      "breaking_section",
      "related_section",
    ]) {
      expect(llmSlots).toContain(slot);
      expect(template.placeholders[slot].required).toBe(false);
    }
  });
});
