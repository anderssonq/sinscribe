import { describe, expect, it } from "vitest";
import { providerExploreKind } from "../src/constants.js";
import {
  buildKiroExploreAgentConfig,
  describeMissingAnswer,
  isLegacyKiroTranscript,
  KIRO_EXPLORE_AGENT_NAME,
  KiroToolTracker,
  parseKiroExploreOutput,
  parseModernKiroAnswer,
  resolveReadNames,
} from "../src/llm/kiro-cli/explore.js";

const REPO = "/work/demo-repo";

describe("buildKiroExploreAgentConfig", () => {
  const config = JSON.parse(buildKiroExploreAgentConfig(`${REPO}/`)) as {
    name: string;
    tools: string[];
    allowedTools: string[];
    mcpServers: Record<string, unknown>;
    includeMcpJson: boolean;
    toolsSettings: {
      fs_read: { allowedPaths: string[]; deniedPaths: string[] };
    };
  };

  it("has fs_read as its only tool, untrusted", () => {
    expect(config.name).toBe(KIRO_EXPLORE_AGENT_NAME);
    expect(config.tools).toEqual(["fs_read"]);
    // A trusted fs_read ignores allowedPaths (verified on kiro-cli 2.3.0).
    expect(config.allowedTools).toEqual([]);
    expect(config.mcpServers).toEqual({});
    expect(config.includeMcpJson).toBe(false);
  });

  it("confines reads to the repository and denies its secrets", () => {
    expect(config.toolsSettings.fs_read.allowedPaths).toEqual([
      REPO,
      `${REPO}/**`,
    ]);
    expect(config.toolsSettings.fs_read.deniedPaths).toContain(
      `${REPO}/**/.env`,
    );
    expect(config.toolsSettings.fs_read.deniedPaths).toContain(
      `${REPO}/**/.git/**`,
    );
  });

  it("keeps the exact key set Kiro accepts", () => {
    expect(Object.keys(config).sort()).toEqual(
      [
        "name",
        "description",
        "prompt",
        "mcpServers",
        "tools",
        "toolAliases",
        "allowedTools",
        "resources",
        "hooks",
        "toolsSettings",
        "includeMcpJson",
        "model",
      ].sort(),
    );
  });
});

describe("parseKiroExploreOutput", () => {
  it("separates a batched read from the final answer", () => {
    const transcript = [
      "\u001b[38;5;141m> \u001b[0mI'll read the files first.",
      "Batch fs_read operation with 2 operations (using tool: read)",
      "Purpose: Read the report",
      `↱ Operation 1: Reading file: ${REPO}/docs/report.md, all lines`,
      `↱ Operation 2: Reading file: ${REPO}/src/upload.ts, all lines`,
      ` ✓ Successfully read 251 bytes from ${REPO}/docs/report.md`,
      ` ✓ Successfully read 185 bytes from ${REPO}/src/upload.ts`,
      " ⋮ ",
      "- Summary: 2 operations processed, 2 successful, 0 failed",
      " - Completed in 0.1s",
      '> {"feature": "Retry uploads",',
      '  "requirements": "> quoted note"}',
      " ▸ Credits: 0.02 • Time: 3s",
    ].join("\n");

    expect(parseKiroExploreOutput(transcript, REPO)).toEqual({
      text: '{"feature": "Retry uploads",\n  "requirements": "> quoted note"}',
      filesRead: ["docs/report.md", "src/upload.ts"],
    });
  });

  it("keeps a markdown quote inside the answer", () => {
    const transcript = [
      `Reading file: ${REPO}/README.md, all lines (using tool: read)`,
      ` ✓ Successfully read 45 bytes from ${REPO}/README.md`,
      " - Completed in 0.0s",
      "> ## Overview",
      "",
      "> A quoted constraint from the README.",
      "",
      "More text.",
      " ▸ Credits: 0.01 • Time: 2s",
    ].join("\n");

    expect(parseKiroExploreOutput(transcript, REPO).text).toBe(
      "## Overview\n\n> A quoted constraint from the README.\n\nMore text.",
    );
  });

  it("does not count rejected or out-of-repo reads", () => {
    const transcript = [
      "Reading file: /etc/hosts, from line 1 to 1 (using tool: read)Command fs_read is rejected because it matches one or more rules on the denied list:",
      "  - non-interactive mode (no user to approve)",
      " ✓ Successfully read 2 bytes from /somewhere/else.txt",
      "> I could not read it.",
    ].join("\n");

    expect(parseKiroExploreOutput(transcript, REPO)).toEqual({
      text: "I could not read it.",
      filesRead: [],
    });
  });

  it("keeps answer lines that look like tool output", () => {
    const transcript = [
      `Reading file: ${REPO}/README.md, all lines (using tool: read)`,
      ` ✓ Successfully read 45 bytes from ${REPO}/README.md`,
      " - Completed in 0.0s",
      "> ## Design",
      "",
      "  - Summary: retries are capped at three",
      "Purpose: keep uploads resilient",
      " ✓ backoff starts at 1s",
      " ▸ Credits: 0.01 • Time: 2s",
    ].join("\n");

    expect(parseKiroExploreOutput(transcript, REPO).text).toBe(
      [
        "## Design",
        "",
        "  - Summary: retries are capped at three",
        "Purpose: keep uploads resilient",
        " ✓ backoff starts at 1s",
      ].join("\n"),
    );
  });

  it("answers without tools when the model read nothing", () => {
    expect(parseKiroExploreOutput("> Just the answer.\n", REPO).text).toBe(
      "Just the answer.",
    );
    expect(parseKiroExploreOutput("no marker at all", REPO).text).toBe("");
  });
});

describe("kiro-cli 2.28 transcript", () => {
  // Shaped by a real 2.28.0 run: narration and answer on stdout with no
  // markers, tool traffic on stderr with bare file names.
  const narration =
    "I'll look at the two explorers alongside package.json and the README.";
  const answer = "# Comparison\n\n- One\n\n> A quoted line.";

  it("starts the answer after the last completed tool call", () => {
    const tracker = new KiroToolTracker();
    let stdout = narration;
    const read = tracker.push(
      "\n[tool] Reading explore.ts:1, package.json:1, README.md:1-1\n" +
        "[tool] status: Completed\n",
      stdout.length,
    );

    stdout += answer;

    expect(read).toEqual(["explore.ts", "package.json", "README.md"]);
    expect(isLegacyKiroTranscript(stdout, tracker.sawToolLine)).toBe(false);
    expect(parseModernKiroAnswer(stdout, tracker.answerOffset)).toBe(answer);
  });

  it("does not count a failed call's reads, even across chunks", () => {
    const tracker = new KiroToolTracker();

    expect(
      tracker.push(
        "[tool] Reading .env:1\n[denied] no approval\n[tool] sta",
        0,
      ),
    ).toEqual([]);
    expect(tracker.push("tus: Failed\n", 0)).toEqual([]);
    expect(
      tracker.push(
        "[tool] Reading listing src, a.ts:1-1\n[tool] status: Completed\n",
        5,
      ),
    ).toEqual(["a.ts"]);
    expect(tracker.names).toEqual(["a.ts"]);
    expect(tracker.answerOffset).toBe(5);
  });

  it("maps bare names to tracked paths, skipping ambiguous ones", () => {
    expect(
      resolveReadNames(
        ["explore.ts", "package.json", "missing.md"],
        ["src/kiro/explore.ts", "src/claude/explore.ts", "package.json"],
      ),
    ).toEqual(["package.json"]);
  });

  it("takes the whole stdout when the model used no tool", () => {
    expect(isLegacyKiroTranscript("Just the answer.\n", false)).toBe(false);
    expect(parseModernKiroAnswer("Just the answer.\n", 0)).toBe(
      "Just the answer.",
    );
  });

  it("still recognises the 2.3.0 transcript", () => {
    expect(
      isLegacyKiroTranscript(
        `Reading file: ${REPO}/README.md, all lines (using tool: read)\n> Hi`,
        false,
      ),
    ).toBe(true);
    expect(isLegacyKiroTranscript("> Just the answer.\n", false)).toBe(true);
  });
});

describe("describeMissingAnswer", () => {
  it("quotes Kiro's last output so the cause is visible", () => {
    const message = describeMissingAnswer(
      "kiro-cli",
      [
        `Reading file: ${REPO}/README.md, all lines (using tool: read)`,
        "\u001b[31mError: You have reached the limit for requests\u001b[0m",
        " ▸ Credits: 0.00 • Time: 1s",
      ].join("\n"),
      "",
      [],
    );

    expect(message.split("\n")[0]).toBe(
      "kiro-cli explored but returned no answer (0 file(s) read): " +
        "Error: You have reached the limit for requests",
    );
    expect(message).not.toContain("Credits");
  });

  it("says so when Kiro printed nothing", () => {
    expect(describeMissingAnswer("kiro-cli", "", "\n", [])).toContain(
      "It printed nothing.",
    );
  });
});

describe("kiro-cli explore capability", () => {
  it("routes kiro-cli through its own read-only explorer", () => {
    expect(providerExploreKind("kiro-cli")).toBe("kiro-cli");
  });
});
