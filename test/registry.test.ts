import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir, removeDir } from "./git-fixture.js";

/** Redirect the user tier so tests never touch a real ~/.sinscribe/templates. */
const FAKE_HOME = vi.hoisted(
  () => `/tmp/sinscribe-registry-home-${process.pid}-${Date.now()}`,
);

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();

  const homedir = (): string => FAKE_HOME;

  return { ...original, default: { ...original, homedir }, homedir };
});

const {
  createTemplateScaffold,
  getBuiltinTemplatesDir,
  getProjectTemplatesDir,
  getUserTemplatesDir,
  loadTemplates,
  resolveTemplate,
  sanitizeTemplateFileName,
  saveUserTemplate,
} = await import("../src/templates/registry.js");
const { parseTemplate } = await import("../src/templates/schema.js");

function template(name: string, kind = "pr"): string {
  return `---
name: ${name}
kind: ${kind}
description: ${name} description
placeholders:
  summary: { type: markdown, required: true, from: llm }
---
## {{summary}}
`;
}

let repo: string;

beforeEach(async () => {
  await mkdir(getUserTemplatesDir(), { recursive: true });
  repo = await makeTempDir("sinscribe-registry-");
});

afterEach(async () => {
  await removeDir(repo);
  await removeDir(FAKE_HOME);
});

async function writeUserTemplate(name: string, content: string): Promise<void> {
  await writeFile(path.join(getUserTemplatesDir(), `${name}.md`), content);
}

async function writeProjectTemplate(
  name: string,
  content: string,
): Promise<void> {
  const dir = getProjectTemplatesDir(repo);

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.md`), content);
}

describe("loadTemplates", () => {
  it("loads the six shipped templates when no other tier exists", async () => {
    const names = (await loadTemplates(null)).map((entry) => entry.name);

    expect(names).toEqual([
      "andersoftware",
      "github",
      "google",
      "kubernetes",
      "shopify",
      "stripe",
    ]);
  });

  it("marks shipped templates as the builtin tier", async () => {
    const templates = await loadTemplates(null);

    expect(templates.every((entry) => entry.tier === "builtin")).toBe(true);
  });

  it("returns templates sorted by name regardless of tier", async () => {
    await writeUserTemplate("aardvark", template("aardvark"));
    await writeUserTemplate("zebra", template("zebra"));

    const names = (await loadTemplates(null)).map((entry) => entry.name);

    expect(names).toEqual([...names].sort());
    expect(names[0]).toBe("aardvark");
    expect(names.at(-1)).toBe("zebra");
  });

  it("adds a user template alongside the built-ins", async () => {
    await writeUserTemplate("myteam", template("myteam"));

    const found = (await loadTemplates(null)).find(
      (entry) => entry.name === "myteam",
    );

    expect(found?.tier).toBe("user");
  });

  it("lets a user template override a built-in of the same name", async () => {
    await writeUserTemplate("github", template("github"));

    const matches = (await loadTemplates(null)).filter(
      (entry) => entry.name === "github",
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.tier).toBe("user");
    expect(matches[0]?.description).toBe("github description");
  });

  it("lets a project template override a user template of the same name", async () => {
    await writeUserTemplate("myteam", template("myteam"));
    await writeProjectTemplate("myteam", template("myteam"));

    const matches = (await loadTemplates(repo)).filter(
      (entry) => entry.name === "myteam",
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.tier).toBe("project");
  });

  it("ignores the project tier when there is no repository root", async () => {
    await writeProjectTemplate("projectonly", template("projectonly"));

    const names = (await loadTemplates(null)).map((entry) => entry.name);

    expect(names).not.toContain("projectonly");
  });

  it("skips a file that does not parse instead of failing the whole load", async () => {
    await writeUserTemplate("broken", "no frontmatter at all");
    await writeUserTemplate("fine", template("fine"));

    const names = (await loadTemplates(null)).map((entry) => entry.name);

    expect(names).toContain("fine");
    expect(names).not.toContain("broken");
  });

  it("ignores files that are not markdown", async () => {
    await writeFile(path.join(getUserTemplatesDir(), "notes.txt"), "ignored");

    await expect(loadTemplates(null)).resolves.toBeInstanceOf(Array);
  });

  it("tolerates a missing user directory", async () => {
    await removeDir(FAKE_HOME);

    await expect(loadTemplates(null)).resolves.toHaveLength(6);
  });

  it("records where each template was loaded from", async () => {
    const github = (await loadTemplates(null)).find(
      (entry) => entry.name === "github",
    );

    expect(github?.sourcePath).toBe(
      path.join(getBuiltinTemplatesDir(), "github.md"),
    );
  });
});

describe("resolveTemplate", () => {
  it("returns the requested template of the requested kind", async () => {
    const found = await resolveTemplate("github", "pr", null);

    expect(found.name).toBe("github");
    expect(found.kind).toBe("pr");
  });

  it("lists the available templates when the name is unknown", async () => {
    await expect(resolveTemplate("nope", "pr", null)).rejects.toThrow(
      /Template not found: nope\. Available pr templates: andersoftware, github/u,
    );
  });

  it("reports a kind mismatch rather than silently using the built-in", async () => {
    await writeUserTemplate("github", template("github", "commit"));

    await expect(resolveTemplate("github", "pr", null)).rejects.toThrow(
      "Template github is a commit template, not a pr template.",
    );
  });

  it("says so plainly when no template of that kind exists", async () => {
    await expect(resolveTemplate("nope", "branch", null)).rejects.toThrow(
      /Available branch templates: \(none\)/u,
    );
  });

  it("prefers the project tier when resolving", async () => {
    await writeProjectTemplate("github", template("github"));

    const found = await resolveTemplate("github", "pr", repo);

    expect(found.tier).toBe("project");
  });
});

describe("saveUserTemplate", () => {
  it("writes the template into the user tier and returns its path", async () => {
    const saved = await saveUserTemplate("myteam", template("myteam"));

    expect(saved).toBe(path.join(getUserTemplatesDir(), "myteam.md"));
    await expect(readFile(saved, "utf8")).resolves.toContain("name: myteam");
  });

  it("refuses to write a template that does not parse", async () => {
    await expect(saveUserTemplate("bad", "not a template")).rejects.toThrow(
      /missing YAML frontmatter/u,
    );
  });

  it("leaves no file behind when validation fails", async () => {
    await saveUserTemplate("good", template("good")).catch(() => undefined);
    await expect(saveUserTemplate("bad", "not a template")).rejects.toThrow();

    await expect(
      readFile(path.join(getUserTemplatesDir(), "bad.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("creates the user directory when it does not exist yet", async () => {
    await removeDir(FAKE_HOME);

    const saved = await saveUserTemplate("myteam", template("myteam"));

    await expect(readFile(saved, "utf8")).resolves.toContain("myteam");
  });

  it("sanitises the filename while leaving the declared name alone", async () => {
    const saved = await saveUserTemplate("My Team", template("My Team"));

    expect(path.basename(saved)).toBe("my-team.md");
  });
});

describe("createTemplateScaffold", () => {
  it("produces a template that parses", () => {
    const parsed = parseTemplate(createTemplateScaffold("myteam"), "myteam.md");

    expect(parsed.name).toBe("myteam");
    expect(parsed.kind).toBe("pr");
  });

  it("declares a slot for every placeholder in its body", () => {
    const parsed = parseTemplate(createTemplateScaffold("myteam"), "myteam.md");
    const used = [
      ...createTemplateScaffold("myteam").matchAll(/\{\{(\w+)\}\}/gu),
    ].map((match) => match[1]);

    for (const slot of used) {
      expect(Object.keys(parsed.placeholders)).toContain(slot);
    }
  });
});

describe("sanitizeTemplateFileName", () => {
  it("lowercases and hyphenates a human-written name", () => {
    expect(sanitizeTemplateFileName("My Team")).toBe("my-team");
  });

  it("collapses runs of unsafe characters into a single hyphen", () => {
    expect(sanitizeTemplateFileName("a///b")).toBe("a-b");
  });

  it("strips leading and trailing separators", () => {
    expect(sanitizeTemplateFileName("--name--")).toBe("name");
    expect(sanitizeTemplateFileName("..name..")).toBe("name");
  });

  it("keeps characters that are already safe", () => {
    expect(sanitizeTemplateFileName("my_team-v2.1")).toBe("my_team-v2.1");
  });

  it("rejects a name with nothing usable left", () => {
    expect(() => sanitizeTemplateFileName("///")).toThrow(
      /Invalid template name/u,
    );
    expect(() => sanitizeTemplateFileName("")).toThrow(
      /Invalid template name/u,
    );
  });
});

describe("template directories", () => {
  it("points the user tier at ~/.sinscribe/templates", () => {
    expect(getUserTemplatesDir()).toBe(
      path.join(FAKE_HOME, ".sinscribe", "templates"),
    );
  });

  it("points the project tier at <repo>/.sinscribe/templates", () => {
    expect(getProjectTemplatesDir("/repo")).toBe(
      path.join("/repo", ".sinscribe", "templates"),
    );
  });

  it("points the builtin tier at the shipped templates directory", async () => {
    await expect(
      readFile(path.join(getBuiltinTemplatesDir(), "github.md"), "utf8"),
    ).resolves.toContain("name: github");
  });
});
