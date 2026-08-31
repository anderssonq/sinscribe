import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec } from "../src/commands.js";
import { CliError } from "../src/domain/errors.js";
import { initRepo, makeTempDir, removeDir } from "./git-fixture.js";

/**
 * The user tier lives under os.homedir(); redirect it so a test run can never
 * touch the developer's real ~/.sinscribe/templates.
 */
const FAKE_HOME = vi.hoisted(
  () => `/tmp/sinscribe-tpl-home-${process.pid}-${Date.now()}`,
);

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();

  const homedir = (): string => FAKE_HOME;

  return { ...original, default: { ...original, homedir }, homedir };
});

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();

  return { ...original, spawn: spawnMock };
});

const { runTemplateCommand } = await import("../src/domain/template.js");
const { getUserTemplatesDir } = await import("../src/templates/registry.js");

type TemplateSpec = Extract<CommandSpec, { name: "template" }>;

function makeSpec(overrides: Partial<TemplateSpec> = {}): TemplateSpec {
  return {
    name: "template",
    action: "list",
    templateName: null,
    from: null,
    ...overrides,
  };
}

const VALID_TEMPLATE = `---
name: myteam
kind: pr
description: A team template
placeholders:
  summary: { type: markdown, required: true, from: llm }
---
## {{summary}}
`;

/** A fake $EDITOR child that exits with the given code. */
function fakeEditor(
  behavior: { kind: "exit"; code: number } | { kind: "error" },
) {
  const child = new EventEmitter();

  queueMicrotask(() => {
    if (behavior.kind === "error") {
      child.emit("error", new Error("spawn ENOENT"));
    } else {
      child.emit("exit", behavior.code);
    }
  });

  return child;
}

let repo: string;

beforeEach(async () => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeEditor({ kind: "exit", code: 0 }));
  await mkdir(getUserTemplatesDir(), { recursive: true });
  repo = await makeTempDir("sinscribe-template-");
  await initRepo(repo);
});

afterEach(async () => {
  await removeDir(repo);
  await removeDir(FAKE_HOME);
});

async function writeProjectTemplate(
  content: string,
  file: string,
): Promise<void> {
  const dir = path.join(repo, ".sinscribe", "templates");

  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), content);
}

describe("runTemplateCommand list", () => {
  it("lists every shipped template with its kind and tier", async () => {
    const output = await runTemplateCommand(makeSpec(), repo, false);

    for (const name of [
      "andersoftware",
      "github",
      "google",
      "kubernetes",
      "shopify",
      "stripe",
    ]) {
      expect(output).toContain(name);
    }
    expect(output).toContain("builtin");
    expect(output).toContain("pr");
  });

  it("shows a project template as the project tier", async () => {
    await writeProjectTemplate(VALID_TEMPLATE, "myteam.md");

    const output = await runTemplateCommand(makeSpec(), repo, false);

    expect(output).toMatch(/myteam.*pr.*project/u);
  });

  it("shows only the winning tier when a project template shadows a built-in", async () => {
    await writeProjectTemplate(
      VALID_TEMPLATE.replace("name: myteam", "name: github"),
      "github.md",
    );

    const output = await runTemplateCommand(makeSpec(), repo, false);
    const githubLines = output
      .split("\n")
      .filter((line) => line.startsWith("github"));

    expect(githubLines).toHaveLength(1);
    expect(githubLines[0]).toContain("project");
  });

  it("skips a template file that does not parse instead of failing the list", async () => {
    await writeProjectTemplate("no frontmatter here", "broken.md");

    const output = await runTemplateCommand(makeSpec(), repo, false);

    expect(output).not.toContain("broken");
    expect(output).toContain("andersoftware");
  });
});

describe("runTemplateCommand show", () => {
  it("prints the full source of a built-in template", async () => {
    const output = await runTemplateCommand(
      makeSpec({ action: "show", templateName: "github" }),
      repo,
      false,
    );

    expect(output).toContain("name: github");
    expect(output).toContain("kind: pr");
  });

  it("reports a template that does not exist", async () => {
    await expect(
      runTemplateCommand(
        makeSpec({ action: "show", templateName: "nope" }),
        repo,
        false,
      ),
    ).rejects.toThrow(CliError);
  });
});

describe("runTemplateCommand add", () => {
  it("writes a scaffold into the user tier and says how to edit it", async () => {
    const output = await runTemplateCommand(
      makeSpec({ action: "add", templateName: "myteam" }),
      repo,
      false,
    );

    expect(output).toContain("Added template myteam");
    expect(output).toContain("sinscribe template edit myteam");

    const written = await readFile(
      path.join(getUserTemplatesDir(), "myteam.md"),
      "utf8",
    );

    expect(written).toContain("name: myteam");
  });

  it("seeds the template from a file when --from is given", async () => {
    const source = path.join(repo, "source.md");

    await writeFile(source, VALID_TEMPLATE);

    const output = await runTemplateCommand(
      makeSpec({ action: "add", templateName: "myteam", from: source }),
      repo,
      false,
    );

    expect(output).toContain("Added template myteam");
    expect(output).not.toContain("template edit");

    const written = await readFile(
      path.join(getUserTemplatesDir(), "myteam.md"),
      "utf8",
    );

    expect(written).toContain("A team template");
  });

  it("refuses to save a --from file that is not a valid template", async () => {
    const source = path.join(repo, "bad.md");

    await writeFile(source, "not a template");

    await expect(
      runTemplateCommand(
        makeSpec({ action: "add", templateName: "bad", from: source }),
        repo,
        false,
      ),
    ).rejects.toThrow(/missing YAML frontmatter/u);
  });

  it("reports a --from file that does not exist", async () => {
    await expect(
      runTemplateCommand(
        makeSpec({
          action: "add",
          templateName: "ghost",
          from: path.join(repo, "missing.md"),
        }),
        repo,
        false,
      ),
    ).rejects.toThrow();
  });

  it("normalises an awkward name into a safe filename", async () => {
    await runTemplateCommand(
      makeSpec({ action: "add", templateName: "My Team!" }),
      repo,
      false,
    );

    const written = await readFile(
      path.join(getUserTemplatesDir(), "my-team.md"),
      "utf8",
    );

    expect(written).toContain("name: my-team");
  });

  it("rejects a name with nothing usable left after sanitising", async () => {
    await expect(
      runTemplateCommand(
        makeSpec({ action: "add", templateName: "///" }),
        repo,
        false,
      ),
    ).rejects.toThrow(/Invalid template name/u);
  });

  it("describes the write without performing it in a dry run", async () => {
    const output = await runTemplateCommand(
      makeSpec({ action: "add", templateName: "myteam" }),
      repo,
      true,
    );

    expect(output).toContain("dry run");
    expect(output).toContain("Would write:");
    expect(output).toContain("built-in scaffold");
    await expect(
      readFile(path.join(getUserTemplatesDir(), "myteam.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("names the source file in a dry run that uses --from", async () => {
    const output = await runTemplateCommand(
      makeSpec({ action: "add", templateName: "myteam", from: "/tmp/x.md" }),
      repo,
      true,
    );

    expect(output).toContain(
      "Source:      /tmp/x.md (validated before saving)",
    );
  });
});

describe("runTemplateCommand edit", () => {
  it("copies a built-in into the user tier before opening it", async () => {
    const output = await runTemplateCommand(
      makeSpec({ action: "edit", templateName: "github" }),
      repo,
      false,
    );

    expect(output).toContain("Saved");
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const copied = await readFile(
      path.join(getUserTemplatesDir(), "github.md"),
      "utf8",
    );

    expect(copied).toContain("name: github");
  });

  it("opens an existing user template in place", async () => {
    await runTemplateCommand(
      makeSpec({ action: "add", templateName: "myteam" }),
      repo,
      false,
    );
    spawnMock.mockClear();

    const output = await runTemplateCommand(
      makeSpec({ action: "edit", templateName: "myteam" }),
      repo,
      false,
    );

    expect(output).toBe(
      `Saved ${path.join(getUserTemplatesDir(), "myteam.md")}`,
    );
  });

  it("uses $EDITOR when it is set", async () => {
    const previous = process.env.EDITOR;

    process.env.EDITOR = "my-editor";

    try {
      await runTemplateCommand(
        makeSpec({ action: "edit", templateName: "github" }),
        repo,
        false,
      );

      expect(spawnMock.mock.calls[0]?.[0]).toBe("my-editor");
    } finally {
      if (previous === undefined) {
        delete process.env.EDITOR;
      } else {
        process.env.EDITOR = previous;
      }
    }
  });

  it("warns instead of claiming success when the edit broke the template", async () => {
    await runTemplateCommand(
      makeSpec({ action: "add", templateName: "myteam" }),
      repo,
      false,
    );

    const target = path.join(getUserTemplatesDir(), "myteam.md");

    spawnMock.mockImplementation(() => {
      void writeFile(target, "the user deleted the frontmatter");

      return fakeEditor({ kind: "exit", code: 0 });
    });

    const output = await runTemplateCommand(
      makeSpec({ action: "edit", templateName: "myteam" }),
      repo,
      false,
    );

    expect(output).toContain("no longer parses");
  });

  it("surfaces a non-zero editor exit as a clean error", async () => {
    spawnMock.mockImplementation(() => fakeEditor({ kind: "exit", code: 1 }));

    await expect(
      runTemplateCommand(
        makeSpec({ action: "edit", templateName: "github" }),
        repo,
        false,
      ),
    ).rejects.toThrow(/exited with code 1/u);
  });

  it("surfaces an editor that cannot be launched as a clean error", async () => {
    spawnMock.mockImplementation(() => fakeEditor({ kind: "error" }));

    await expect(
      runTemplateCommand(
        makeSpec({ action: "edit", templateName: "github" }),
        repo,
        false,
      ),
    ).rejects.toThrow(/Could not launch editor/u);
  });

  it("reports a template that does not exist", async () => {
    await expect(
      runTemplateCommand(
        makeSpec({ action: "edit", templateName: "nope" }),
        repo,
        false,
      ),
    ).rejects.toThrow(CliError);
  });

  it("describes the copy without opening an editor in a dry run", async () => {
    const output = await runTemplateCommand(
      makeSpec({ action: "edit", templateName: "github" }),
      repo,
      true,
    );

    expect(output).toContain("Would copy builtin");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("describes opening a user template without opening it in a dry run", async () => {
    await runTemplateCommand(
      makeSpec({ action: "add", templateName: "myteam" }),
      repo,
      false,
    );
    spawnMock.mockClear();

    const output = await runTemplateCommand(
      makeSpec({ action: "edit", templateName: "myteam" }),
      repo,
      true,
    );

    expect(output).toContain("Would open");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("runTemplateCommand path", () => {
  it("prints all three tier directories inside a repository", async () => {
    const output = await runTemplateCommand(
      makeSpec({ action: "path" }),
      repo,
      false,
    );

    expect(output).toContain("builtin  ");
    expect(output).toContain(`user     ${getUserTemplatesDir()}`);
    expect(output).toContain(path.join(".sinscribe", "templates"));
  });

  it("says so plainly when there is no project tier to report", async () => {
    const plain = await makeTempDir("sinscribe-not-a-repo-");

    try {
      const output = await runTemplateCommand(
        makeSpec({ action: "path" }),
        plain,
        false,
      );

      expect(output).toContain("project  (not in a git repository)");
    } finally {
      await removeDir(plain);
    }
  });
});
