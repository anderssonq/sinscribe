import { describe, expect, it } from "vitest";
import {
  createBranchSystemPrompt,
  createDocsSystemPrompt,
  createPromptSystemPrompt,
  createPrSystemPrompt,
} from "../src/domain/prompts.js";
import { parseTemplate } from "../src/templates/schema.js";

const TEMPLATE = parseTemplate(
  `---
name: sample
kind: pr
placeholders:
  summary: { type: markdown, required: true, from: llm }
  changes: { type: list, required: true, from: llm }
---
{{summary}}

{{changes}}
`,
  "sample.md",
);

describe("createPrSystemPrompt", () => {
  it("lists every LLM placeholder key", () => {
    const prompt = createPrSystemPrompt(TEMPLATE);

    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"changes"');
    expect(prompt).toContain("Business context");
    expect(prompt).not.toContain("previously generated PR description");
  });

  it("adds the update instruction in update mode and keeps the keys", () => {
    const prompt = createPrSystemPrompt(TEMPLATE, { update: true });

    expect(prompt).toContain("previously generated PR description");
    expect(prompt).toContain("full replacement, not a patch");
    expect(prompt).toContain('"summary"');
    expect(prompt).toContain('"changes"');
    expect(prompt).not.toContain("gave feedback");
  });

  it("adds the feedback rule when the author requested changes", () => {
    const prompt = createPrSystemPrompt(TEMPLATE, {
      update: true,
      feedback: true,
    });

    expect(prompt).toContain("gave feedback");
    expect(prompt).toContain("Apply every point of the feedback");
  });

  it("always demands a breaking-change scan, naming the slot when one exists", () => {
    const generic = createPrSystemPrompt(TEMPLATE);

    expect(generic).toContain("Scan the diff for breaking changes");
    expect(generic).toContain("newly required config fields");
    expect(generic).toContain("whichever field or checklist");

    const slotted = parseTemplate(
      `---
name: slotted
kind: pr
placeholders:
  summary: { type: markdown, required: true, from: llm }
  breaking_section: { type: markdown, required: false, from: llm }
---
{{summary}}

{{breaking_section}}
`,
      "slotted.md",
    );

    expect(createPrSystemPrompt(slotted)).toContain(
      'record any in "breaking_section"',
    );
  });

  it("asks for a reference to the actual ticket only when one is available", () => {
    const withTicket = createPrSystemPrompt(TEMPLATE, { ticket: "ABC-123" });

    expect(withTicket).toContain("The ticket for this branch is ABC-123");
    expect(withTicket).toContain('"Refs ABC-123"');
    expect(withTicket).toContain("following that field's format");
    expect(createPrSystemPrompt(TEMPLATE)).not.toContain("Refs");
  });
});

describe("createPromptSystemPrompt", () => {
  it("demands the feature spec sections and markdown-only output", () => {
    const prompt = createPromptSystemPrompt("feature");

    expect(prompt).toContain("## Objective");
    expect(prompt).toContain("## Out of scope");
    expect(prompt).toContain("## Verification");
    expect(prompt).toContain("ONLY the markdown document");
    expect(prompt).toContain("no trailing remark after the last section");
    expect(prompt).toContain("no surrounding code fence");
    expect(prompt).not.toContain("JSON");
    expect(prompt).not.toContain("previously generated prompt");
  });

  it("frames existing commits as background without banning symptom claims", () => {
    const prompt = createPromptSystemPrompt("bugfix");

    expect(prompt).toContain("background on the same effort");
    expect(prompt).toContain("from their presence alone");
    // The rule must stay scoped to the git state: a categorical ban would
    // contradict the bugfix skeleton's Symptom/Suspected cause sections.
    expect(prompt).not.toContain("Never assert");
  });

  it("swaps in the bugfix skeleton with a failing-test-first rule", () => {
    const prompt = createPromptSystemPrompt("bugfix");

    expect(prompt).toContain("## Symptom");
    expect(prompt).toContain("## Reproduction");
    expect(prompt).toContain("failing test");
    expect(prompt).not.toContain("## Objective");
  });

  it("adds the update and feedback rules for the refine loop", () => {
    const prompt = createPromptSystemPrompt("feature", {
      update: true,
      feedback: true,
    });

    expect(prompt).toContain("previously generated prompt");
    expect(prompt).toContain("full replacement, not a patch");
    expect(prompt).toContain("Apply every point of the feedback");
  });
});

describe("createBranchSystemPrompt", () => {
  it("keeps the JSON contract and explains the business context block", () => {
    const prompt = createBranchSystemPrompt();

    expect(prompt).toContain('"slugs"');
    expect(prompt).toContain("Business context");
    expect(prompt).toContain("never include the ticket ID inside a slug");
  });

  it("asks for whole names in the author's format when preferences are given", () => {
    const prompt = createBranchSystemPrompt(true);

    expect(prompt).toContain('"names"');
    expect(prompt).not.toContain('"slugs"');
    expect(prompt).toContain("Follow the author's format exactly");
    expect(prompt).toContain("valid git branch ref");
  });
});

describe("createDocsSystemPrompt", () => {
  it("demands a read-only agent producing the fixed markdown sections", () => {
    const prompt = createDocsSystemPrompt();

    expect(prompt).toContain("Do not write or modify any files");
    expect(prompt).toContain("Do not read .env files or secrets");
    expect(prompt).toContain("mermaid");
    expect(prompt).toContain("## Architecture");
    expect(prompt).toContain("## Module dependencies");
    expect(prompt).toContain("only the markdown document");
  });
});
