import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CommandSpec } from "../commands.js";
import { getRepoRoot, isGitRepo } from "../git/repo.js";
import {
  createTemplateScaffold,
  getBuiltinTemplatesDir,
  getProjectTemplatesDir,
  getUserTemplatesDir,
  loadTemplates,
  sanitizeTemplateFileName,
  saveUserTemplate,
} from "../templates/registry.js";
import { parseTemplate } from "../templates/schema.js";
import { CliError } from "./errors.js";

type TemplateSpec = Extract<CommandSpec, { name: "template" }>;

/** Template management never calls the LLM and never reads credentials. */
export async function runTemplateCommand(
  spec: TemplateSpec,
  cwd: string,
  dryRun: boolean,
): Promise<string> {
  const repoRoot = (await isGitRepo(cwd)) ? await getRepoRoot(cwd) : null;

  switch (spec.action) {
    case "list": {
      const templates = await loadTemplates(repoRoot);

      if (templates.length === 0) {
        return "No templates found.";
      }

      const nameWidth = Math.max(
        ...templates.map((template) => template.name.length),
      );

      return templates
        .map(
          (template) =>
            `${template.name.padEnd(nameWidth)}  ${template.kind.padEnd(6)}  ${template.tier.padEnd(7)}  ${template.description}`,
        )
        .join("\n");
    }

    case "show": {
      const templates = await loadTemplates(repoRoot);
      const template = templates.find(
        (entry) => entry.name === spec.templateName,
      );

      if (!template) {
        throw new CliError(`Template not found: ${spec.templateName}`);
      }

      return (await readFile(template.sourcePath, "utf8")).trimEnd();
    }

    case "add": {
      const name = sanitizeTemplateFileName(spec.templateName ?? "");
      const targetPath = path.join(getUserTemplatesDir(), `${name}.md`);

      if (dryRun) {
        return [
          "sinscribe template add (dry run)",
          `Would write: ${targetPath}`,
          spec.from
            ? `Source:      ${spec.from} (validated before saving)`
            : "Source:      built-in scaffold",
        ].join("\n");
      }

      const content = spec.from
        ? await readFile(spec.from, "utf8")
        : createTemplateScaffold(name);
      const savedPath = await saveUserTemplate(name, content);

      return `Added template ${name} at ${savedPath}${spec.from ? "" : "\nEdit it with: sinscribe template edit " + name}`;
    }

    case "edit": {
      const templates = await loadTemplates(repoRoot);
      const template = templates.find(
        (entry) => entry.name === spec.templateName,
      );

      if (!template) {
        throw new CliError(`Template not found: ${spec.templateName}`);
      }

      let editPath = template.sourcePath;

      // Built-ins are shipped with the package: copy to the user tier first.
      if (template.tier === "builtin") {
        const userPath = path.join(
          getUserTemplatesDir(),
          path.basename(template.sourcePath),
        );

        if (dryRun) {
          return `sinscribe template edit (dry run)\nWould copy builtin ${template.sourcePath} to ${userPath} and open $EDITOR.`;
        }

        await saveUserTemplate(
          template.name,
          await readFile(template.sourcePath, "utf8"),
        );
        editPath = userPath;
      } else if (dryRun) {
        return `sinscribe template edit (dry run)\nWould open ${editPath} in $EDITOR.`;
      }

      await openInEditor(editPath);

      // Re-validate after editing so a broken template is caught immediately.
      try {
        parseTemplate(await readFile(editPath, "utf8"), editPath);
      } catch (error) {
        return `Saved ${editPath}, but it no longer parses: ${error instanceof Error ? error.message : String(error)}`;
      }

      return `Saved ${editPath}`;
    }

    case "path":
      return [
        `builtin  ${getBuiltinTemplatesDir()}`,
        `user     ${getUserTemplatesDir()}`,
        `project  ${repoRoot ? getProjectTemplatesDir(repoRoot) : "(not in a git repository)"}`,
      ].join("\n");
  }
}

async function openInEditor(filePath: string): Promise<void> {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";

  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [filePath], { stdio: "inherit" });

    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new CliError(`${editor} exited with code ${code ?? "unknown"}`));
      }
    });
    child.on("error", (error) => {
      reject(
        new CliError(`Could not launch editor ${editor}: ${error.message}`),
      );
    });
  });
}
