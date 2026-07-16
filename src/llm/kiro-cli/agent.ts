import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sinscribeEnvDir } from "../../env.js";

/**
 * The tools-less Kiro CLI agent that keeps single-shot commands single-shot.
 *
 * `--trust-tools=` does NOT do this. That flag governs *auto-approval* of
 * available tools; the agent config's `tools` field governs *availability*
 * ("lists all tools that the agent can potentially use" — AWS's own
 * agent-format docs). Verified against kiro-cli 2.3.0: with
 * `--trust-tools=` the model happily read a directory, while with this
 * `tools: []` agent it answers "I don't have access to a file-reading or
 * directory-listing tool in this session".
 *
 * The config lives in a directory Sinscribe owns rather than Kiro's global
 * agent dir (~/.kiro/agents), so we never touch the user's own agents, and
 * discovery stays deterministic: Kiro finds workspace agents under the cwd,
 * and we spawn with cwd set here. With no tools, that cwd is invisible to
 * the model anyway — it cannot read the repository at all.
 */

export const KIRO_AGENT_NAME = "sinscribe";

/** Root we pass as the child's cwd; Kiro discovers agents beneath it. */
export function getKiroAgentDir(): string {
  return path.join(sinscribeEnvDir, "kiro-agent");
}

function getAgentConfigPath(agentDir: string): string {
  return path.join(
    agentDir,
    ".amazonq",
    "cli-agents",
    `${KIRO_AGENT_NAME}.json`,
  );
}

/**
 * The config Kiro CLI accepts. Field-for-field the shape of its own
 * `agent_config.json.example`: an unknown key (a `$schema` line, say) makes
 * Kiro skip the file silently — it simply never appears in `agent list`,
 * and `--agent` then falls back to a built-in agent that HAS tools. So the
 * shape here is deliberately exact, and the caller must verify the agent
 * was actually used rather than trusting the flag.
 */
function buildAgentConfig(): string {
  return `${JSON.stringify(
    {
      name: KIRO_AGENT_NAME,
      description:
        "Sinscribe single-shot text generation. No tools, by design.",
      prompt: null,
      mcpServers: {},
      // The whole point: an empty allowlist means no tool exists to run.
      tools: [],
      toolAliases: {},
      allowedTools: [],
      resources: [],
      hooks: {},
      toolsSettings: {},
      // Never inherit the user's MCP servers — they would add tools back.
      includeMcpJson: false,
      model: null,
    },
    null,
    2,
  )}\n`;
}

/**
 * Writes the agent config (idempotent) and returns the directory to spawn
 * in. Rewritten on every run on purpose: it is cheap, and it self-heals if
 * the file was deleted or edited — a missing config would otherwise
 * downgrade us to a tool-enabled agent.
 */
export async function ensureKiroAgent(): Promise<string> {
  const agentDir = getKiroAgentDir();
  const configPath = getAgentConfigPath(agentDir);

  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, buildAgentConfig(), "utf8");

  return agentDir;
}
