import type { Template } from "../templates/schema.js";
import { getLlmPlaceholderNames } from "../templates/render.js";
import { HANDOFF_SECTIONS } from "./handoff-export.js";

export const JSON_ONLY_INSTRUCTION =
  "Respond with a single JSON object and nothing else: no prose, no markdown fence.";

const RULES_PREFACE =
  "Additional rules provided by the user/team — follow them in addition to everything above:";

/**
 * Appends author-provided rules to a finished system prompt. A separate
 * preface (not "Rules:") so it never reads as one more item in a builder's
 * own internal Rules: list. `rules === null` returns the input unchanged.
 */
export function appendRules(
  systemPrompt: string,
  rules: string | null,
): string {
  return rules === null
    ? systemPrompt
    : `${systemPrompt}\n\n${RULES_PREFACE}\n${rules}`;
}

export function createPrSystemPrompt(
  template: Template,
  options: {
    update?: boolean;
    feedback?: boolean;
    ticket?: string | null;
  } = {},
  rules: string | null,
): string {
  const llmSlots = getLlmPlaceholderNames(template);
  const slotDescriptions = llmSlots
    .map((name) => {
      const spec = template.placeholders[name];
      const shape =
        spec.type === "list"
          ? "array of short strings"
          : spec.type === "markdown"
            ? "markdown string (may contain multiple paragraphs or bullets)"
            : "single-line string";

      return `- "${name}": ${shape}${spec.required ? "" : " (optional; omit if nothing meaningful to say)"}${
        spec.description ? ` — ${spec.description}` : ""
      }`;
    })
    .join("\n");
  // Naming the exact slot makes the model fill it far more reliably than a
  // generic hint, so point at one when the template names it; templates that
  // fold breaking changes into another field get the generic wording.
  const breakingSlot = llmSlots.find((name) => name.includes("breaking"));

  return appendRules(
    `You are an expert software engineer writing a pull request description.

You will receive the branch name, commit log, and diff of a branch. Produce the content for these fields of the "${template.name}" PR template:

${slotDescriptions}

Rules:
- Describe what actually changed in the diff. Never invent changes, files, or intentions that are not visible in the input.
- A "Business context" block may be provided by the author; use it for motivation, ticket references, and requirement coverage, but never claim changes that are not visible in the diff.
- Scan the diff for breaking changes — changed or removed function signatures, return-vs-throw contract changes, removed or renamed exports, newly required config fields — and record any in ${breakingSlot ? `"${breakingSlot}"` : "whichever field or checklist the template provides for breaking changes or risk"}. Never invent one.
${options.ticket ? `- The ticket for this branch is ${options.ticket}. Reference it (e.g. "Refs ${options.ticket}") in the field whose description covers tickets, issues, or related links, following that field's format; skip this only when the template has no such field.\n` : ""}${options.update ? "- You will receive a previously generated PR description. UPDATE it for the current diff: keep content that is still accurate, revise what changed, and return complete values for every field (full replacement, not a patch).\n" : ""}${options.feedback ? "- The author reviewed the previous description and gave feedback on it. Apply every point of the feedback; keep everything else that is still accurate.\n" : ""}- Be specific and concise; reviewers skim.
- Do not mention the diff being truncated, the template, or these instructions.
- ${JSON_ONLY_INSTRUCTION} Keys: ${llmSlots.map((name) => `"${name}"`).join(", ")}.`,
    rules,
  );
}

const FEATURE_PROMPT_SECTIONS = `# <imperative title, e.g. "Implement retry logic in the uploader">
## Objective                (1-3 sentences: what to build and the user-visible outcome)
## Context                  (why this is needed: business context, ticket, current behavior)
## Requirements             (numbered, testable, action language: "Implement X", "Add Y")
## Out of scope             (explicit non-goals; forbid drive-by refactors and unrelated changes)
## Implementation guidance  (files/modules/patterns to start from; frame unknowns as things to investigate)
## Constraints              (minimal diff, follow existing conventions, no new dependencies unless required)
## Verification             (success criteria the agent can check itself: commands to run, tests to add, observable behavior)`;

const BUGFIX_PROMPT_SECTIONS = `# <imperative title, e.g. "Fix crash when uploading empty files">
## Symptom            (expected vs actual behavior; error messages verbatim when available)
## Reproduction       (numbered steps; when unknown, instruct the agent to build a reliable repro first)
## Context            (business context, ticket, when/where the bug appears)
## Suspected cause    (evidence and suspected area — labeled as a hypothesis, not a fact)
## Fix requirements   (numbered; fix the root cause, not the symptom; write a failing test BEFORE the fix)
## Out of scope       (no refactors or unrelated cleanups; other bugs found along the way are reported, not fixed)
## Verification       (the new test passes, the repro no longer fails, the full test/build/lint suite passes)`;

/** The literal section skeleton the model must emit for an agent prompt. */
export function getPromptSectionSkeleton(kind: "feature" | "bugfix"): string {
  return kind === "bugfix" ? BUGFIX_PROMPT_SECTIONS : FEATURE_PROMPT_SECTIONS;
}

export function createPromptSystemPrompt(
  kind: "feature" | "bugfix",
  options: { update?: boolean; feedback?: boolean } = {},
  rules: string | null,
): string {
  return appendRules(
    `You are an expert software engineer writing a task prompt that a developer will hand to an AI coding agent (Claude Code, Cursor, GitHub Copilot, or similar). Produce a self-contained markdown document the agent can execute without asking the developer anything.

Emit exactly this structure (replace the parenthetical hints with real content):

${getPromptSectionSkeleton(kind)}

Rules:
- Ground every claim in the provided context (branch, ticket, business context, commits, changed files, and the developer's description). Never invent file paths, APIs, or behavior; when the code area is unknown, write the guidance as an investigation instruction, not a fact.
- The prompt must tell the agent to read the referenced files and explore the codebase before changing anything, and never to speculate about code it has not opened.
- Commits and changed files in the input are background on the same effort. Do not, from their presence alone, claim the task is already done or that existing code is incomplete or incorrect; have the agent read those files first.
- Requirements must be explicit, numbered, testable, and written as actions — no "could you", no vague goals.
- Cover exactly one ${kind === "bugfix" ? "bug" : "feature"}; if the description mixes several tasks, cover the primary one and list the rest under Out of scope.
- Always include the motivation (the why) so the agent makes correct judgment calls.
- Verification must be runnable by the agent: name concrete commands when the context provides them, otherwise instruct the agent to discover and run the project's test/build/lint commands.
- Reference the ticket ID in Context when one is provided.
- Agent-agnostic plain markdown only: no XML tags, no tool-specific directives, no mention of any particular AI product inside the document.
${options.update ? "- You will receive a previously generated prompt. Revise it with the new information: keep sections that are still accurate and return the complete document (full replacement, not a patch).\n" : ""}${options.feedback ? "- The developer reviewed the previous prompt and gave feedback on it. Apply every point of the feedback; keep everything else that is still accurate.\n" : ""}- Be as short as possible while complete; every line must earn its place.
- Respond with ONLY the markdown document: no preamble, no explanation, no trailing remark after the last section, and no surrounding code fence.`,
    rules,
  );
}

export function createHandoffSystemPrompt(
  options: { update?: boolean; feedback?: boolean } = {},
  rules: string | null,
): string {
  return appendRules(
    `You are an experienced engineer writing the handoff note for a branch at the end of a working session. The reader is the next person — or the next AI coding agent — to pick this branch up cold. Produce a short markdown document that tells them the current state of the work.

Emit exactly these sections, in this order (replace the parenthetical hints with real content):

${HANDOFF_SECTIONS}

Rules:
- Start at "## Where things stand". Do not write a title, a date, or any heading above it — those are added for you.
- Ground every line in the provided context (branch, ticket, business context, commits, changed files, the agent prompt for this session, and any previous handoff). Never invent files, decisions, or outcomes.
- The agent prompt describes work that is about to be handed to a coding agent — it is the plan, not a completed result. Do not report its requirements as done.
- This document is a snapshot, not a changelog: describe the state as it is now. Never keep a dated log of past sessions.
- Short bullets, one fact each. A section with nothing real to say gets a single "- None." bullet rather than filler.
- Write "Open questions" as questions and "Next steps" as ordered, concrete actions.
${options.update ? '- You will receive the previous handoff. UPDATE it: keep what is still true, revise what changed, drop what is resolved (a resolved question moves out of "Open questions", it is not marked answered in place). Return the complete document, not a patch.\n' : ""}${options.feedback ? "- The author reviewed the previous draft and gave feedback on it. Apply every point; keep everything else that is still accurate.\n" : ""}- Respond with ONLY the markdown sections: no preamble, no explanation, no trailing remark, and no surrounding code fence.`,
    rules,
  );
}

export function createCommitSystemPrompt(
  gitmoji: boolean,
  rules: string | null,
): string {
  return appendRules(
    `You are an expert software engineer writing a commit message for the staged changes you receive.

Produce a Conventional Commits message. Respond with a single JSON object:
- "type": one of feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert
- "scope": short lowercase scope, or null when no scope fits
- "subject": imperative, lowercase start, no trailing period, <= 72 chars
- "body": optional markdown body explaining what and why (null when the subject is enough)
- "breaking": optional description of a breaking change (null when none)

Rules:
- Describe only what the diff actually changes.
- Pick the single dominant type; do not combine.
${gitmoji ? "- The CLI prefixes the matching gitmoji itself; do not include emoji.\n" : ""}- ${JSON_ONLY_INSTRUCTION}`,
    rules,
  );
}

export function createBranchSystemPrompt(
  withPreferences = false,
  rules: string | null,
): string {
  if (withPreferences) {
    return appendRules(
      `You generate git branch names in the exact format the author asks for.

You receive the branch's subject (a ticket ID and/or a task description) plus the author's formatting preferences. Respond with a single JSON object:
- "names": array of exactly 3 alternative full branch names that follow the requested format

Rules:
- Follow the author's format exactly: prefix, separators, casing, and where the ticket ID goes.
- Use the given ticket ID verbatim where the format calls for it; if no ticket is available, omit that part and keep the rest of the format intact.
- Turn the task description into a concise, concrete kebab-case fragment (lowercase, ASCII, "-" between words) — never generic like "update-code".
- A "Business context" block may accompany the subject; use it to make the description fragment specific.
- Each name must be a valid git branch ref: ASCII only, no spaces, no "..", and it must not begin or end with "/", "-", or ".".
- ${JSON_ONLY_INSTRUCTION}`,
      rules,
    );
  }

  return appendRules(
    `You suggest git branch names.

Given a ticket ID and/or a short task description, respond with a single JSON object:
- "type": one of feat, fix, chore, docs, refactor, test, perf, build, ci, hotfix
- "slugs": array of exactly 3 alternative kebab-case slugs (lowercase, ASCII, words separated by "-", <= 40 chars, no ticket ID inside)

Rules:
- Slugs must be concrete and descriptive, not generic like "update-code".
- A "Business context" block may accompany the task; use it to make the slugs concrete and specific, but never include the ticket ID inside a slug.
- ${JSON_ONLY_INSTRUCTION}`,
    rules,
  );
}

export function createContextSystemPrompt(
  format: "md" | "json",
  rules: string | null,
): string {
  return appendRules(
    `You are Sinscribe, a senior engineer producing a project-context brief that another developer or AI agent can use to start working on this repository immediately.

Explore the repository with the available tools (ls, glob, grep, read_file; shell execute for git). Filesystem tools use a virtual root: / is the repository root. Do not write or modify any files. Do not read .env files or secrets. Do not search outside the repository.

Inspect: package/config manifests, lockfiles, entrypoints, folder layout, build/test/lint scripts, CI config, README and docs, and a few representative source files per major module. Use git log briefly for context on activity.

Then output the brief as your final message${
      format === "json"
        ? " as a single JSON object with keys: name, purpose, stack, entrypoints, key_modules, conventions, scripts, testing, notes. No prose outside the JSON."
        : ` in markdown with exactly these sections:
# Project Context: <name>
## Purpose
## Stack
## Entrypoints
## Key modules
## Conventions
## Scripts & workflows
## Testing
## Notes for agents`
    }

Ground every claim in files you inspected; reference paths inline. Be concise: the whole brief should fit in one screen or two.`,
    rules,
  );
}

export function createDocsSystemPrompt(rules: string | null): string {
  return appendRules(
    `You are Sinscribe, a senior engineer writing developer documentation for this repository.

Explore the repository with the available tools (ls, glob, grep, read_file; shell execute for git). Filesystem tools use a virtual root: / is the repository root. Do not write or modify any files. Do not read .env files or secrets. Do not search outside the repository.

Inspect: package/config manifests, entrypoints, module layout, build/test/lint scripts, CI config, existing docs, and representative source files per major module.

Then output, as your final message, a single markdown document with exactly these sections:
# <Project name> — Documentation
## Overview            (what it is and who it's for, one short paragraph)
## Architecture        (prose plus a \`\`\`mermaid flowchart of the main modules/layers)
## Data flow           (prose plus a \`\`\`mermaid diagram of a representative end-to-end flow)
## Module dependencies (a \`\`\`mermaid graph of dependencies between top-level source modules)
## Getting started     (install/build/test commands actually found in the repo)
## Key workflows       (the 2-4 most important runtime flows, grounded in code)
## Conventions & notes (patterns, pitfalls, where to add things)

Rules:
- Ground every claim in files you inspected; reference paths inline.
- Mermaid blocks must be valid mermaid (flowchart/graph syntax); keep node labels short.
- Follow documentation best practices: lead with purpose, keep sections skimmable, no filler.
- The final message must be only the markdown document — no preamble.`,
    rules,
  );
}

export function createAgentsSystemPrompt(
  target: "claude" | "agents" | "both",
  update: boolean,
  rules: string | null,
): string {
  const files =
    target === "both"
      ? "/CLAUDE.md and /AGENTS.md"
      : target === "claude"
        ? "/CLAUDE.md"
        : "/AGENTS.md";

  return appendRules(
    `You are Sinscribe, generating AI agent context files for this repository by inferring them from the project itself.

Explore the repository with the available tools (ls, glob, grep, read_file; shell execute for git). Filesystem tools use a virtual root: / is the repository root. Do not read .env files or secrets. Do not search outside the repository.

Your job: ${update ? `update the existing ${files} surgically. Read the current content first; preserve accurate hand-written instructions and only fix what is stale, missing, or wrong. Do not reformat or rewrite sections that are still correct.` : `create ${files} at the repository root. If a file already exists, read it first and merge: preserve hand-written instructions, add what is missing.`}

A good agent context file contains, briefly:
- What the project is and does (1-2 sentences)
- Stack, package manager, and the exact build/test/lint commands
- Repository layout: where the important code lives
- Project conventions an agent must follow (style, naming, patterns actually used in the code)
- Warnings: what not to touch, known pitfalls

Rules:
- Every claim must come from files you actually inspected. Never invent commands or conventions.
- Keep each file under ~80 lines. Agents read this on every task; brevity is a feature.
- When writing both files, they may share content; write both fully.
- Write the file(s) with write_file/edit_file using virtual paths (${files}).
- Only write ${files}. Do not modify anything else.
- Finish with a short summary of what you wrote or changed.`,
    rules,
  );
}

/** The exploration paragraph every agentic prompt opens with. */
const AGENTIC_EXPLORE_PREAMBLE = `Explore the repository with the available tools (ls, glob, grep, read_file; shell execute for git). Filesystem tools use a virtual root: / is the repository root. Do not read .env files or secrets. Do not search outside the repository.`;

/**
 * Pass 1 of "set up project agents": inspect the repository and report what
 * roster it needs plus what only a human can answer. Read-only — the write
 * pass is a separate call, so a bad plan costs nothing on disk.
 */
export function createAgentPlanSystemPrompt(rules: string | null): string {
  return appendRules(
    `You are Sinscribe, planning the roster of specialized AI coding agents this repository should have.

${AGENTIC_EXPLORE_PREAMBLE} Do not write or modify any files — this is an analysis pass only.

Inspect: package/config manifests and lockfiles, entrypoints, folder layout, build/test/lint scripts, CI config, README and existing docs, any existing agent/context files, and a few representative source files per major module. Use git log briefly for a sense of what is actively worked on.

Then propose:
- One agent per real technical surface you found — the backend framework actually in use (NestJS, .NET, Django, Rails, …), the frontend framework actually in use (React, Vue, Angular, Svelte, …), mobile, infrastructure, database/migrations — never a surface you did not find evidence for.
- The cross-cutting agents this project would benefit from: commit messages, tests, code review, documentation, and any workflow the repository's own scripts or CI reveal.
- The questions you genuinely cannot answer from the code: product goals, target users, business rules, team conventions that are not visible in the diff, non-obvious constraints. Ask nothing whose answer you could have read in a file, and ask at most six.

Rules:
- Ground the stack and every role in files you actually inspected. Never invent a framework, a command, or a module.
- Prefer few strong agents over many thin ones; if two roles would share the same instructions, they are one agent.
- Each "id" is a lowercase kebab-case slug, used verbatim as a file name (e.g. "nestjs-backend", "react-frontend", "commit-writer").
- Each "role" is one sentence saying what that agent owns in THIS project, naming the framework or area concretely.
- Write each "question" so it stands alone, and "why" as the one-line reason answering it will make the agents better.
- Set "multiline" to false only for short factual answers (a name, a URL, a single choice).
- ${JSON_ONLY_INSTRUCTION} Keys: "stack" (array of short strings), "roster" (array of objects with "id", "label", "role"), "questions" (array of objects with "id", "question", "why", "multiline").`,
    rules,
  );
}

/**
 * Pass 2: write the definitions the author confirmed. Takes an explicit path
 * whitelist split by create-vs-update, because deepagents' write_file refuses
 * to overwrite an existing file — and because a whitelist the model cannot
 * widen is a stronger guarantee than a "do not touch X" instruction.
 */
export function createAgentWriteSystemPrompt(
  input: {
    create: Array<{ id: string; label: string; role: string }>;
    update: Array<{ id: string; label: string; role: string }>;
    stack: string[];
    answers: Array<{ question: string; answer: string }>;
  },
  rules: string | null,
): string {
  const describe = (agent: { id: string; label: string; role: string }) =>
    `- /.claude/agents/${agent.id}.md — ${agent.label}: ${agent.role}`;
  const createBlock =
    input.create.length > 0
      ? `Create these files with write_file (they do not exist yet):\n${input.create.map(describe).join("\n")}\n`
      : "";
  // write_file errors on an existing path, so these must go through read+edit.
  const updateBlock =
    input.update.length > 0
      ? `Update these files in place — read_file first, then edit_file. They already exist, so write_file will fail on them. Preserve any hand-written instruction that is still accurate and change only what is stale, missing, or wrong:\n${input.update.map(describe).join("\n")}\n`
      : "";
  const answersBlock =
    input.answers.length > 0
      ? `\nThe author answered these questions about the project. Treat the answers as authoritative — they cover what the code cannot show you:\n${input.answers
          .map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`)
          .join("\n\n")}\n`
      : "";

  return appendRules(
    `You are Sinscribe, writing the specialized AI agent definitions for this repository.

${AGENTIC_EXPLORE_PREAMBLE}

${input.stack.length > 0 ? `The analysis pass found this stack: ${input.stack.join(", ")}. Confirm anything you rely on by reading the file it comes from.\n` : ""}${answersBlock}
${createBlock}${updateBlock}
Each file is a standalone agent definition in this format:

---
name: <the file's slug>
description: <when to invoke this agent, in the third person, with two or three concrete example requests that should trigger it>
model: sonnet
---

<the agent's instructions>

What makes these definitions good:
- The description is the only thing a dispatcher reads when choosing an agent. Make it trigger-oriented and specific ("Use when adding or changing a NestJS controller, module, or provider…"), never a job title.
- Open the body with the agent's scope in one or two sentences, then its explicit non-goals — what it must hand off rather than touch.
- Name this project's real commands, paths, and patterns: the actual test command, the actual directory a controller lives in, the conventions the existing code already follows. A definition that would fit any project is worthless.
- Prefer imperative instructions over description. Say what to do and in what order.
- Keep each file under about 60 lines. Agents read this on every task; brevity is a feature.

Rules:
- Every claim must come from a file you actually inspected or from the author's answers above. Never invent a command, a path, or a convention.
- Write EXACTLY the files listed above, using those virtual paths. Do not create, rename, or modify any other file for any reason.
- Do not write CLAUDE.md or AGENTS.md — a separate command owns those.
- Finish with one short line per file saying what you wrote or changed.`,
    rules,
  );
}

export function createChatSystemPrompt(rules: string | null): string {
  return appendRules(
    `You are Sinscribe, a git-centric developer-workflow assistant running in an interactive terminal session inside a repository.

You can explore the repository with the available tools (ls, glob, grep, read_file; shell execute for git commands). Filesystem tools use a virtual root: / is the repository root. Do not read .env files or secrets. Do not search outside the repository. Do not modify files unless the user explicitly asks.

You help with: understanding the repo, drafting PR descriptions and commit messages, suggesting branch names, and explaining diffs and history. For full workflows, point the user at the subcommands: sinscribe pr, commit, branch, context, agents, template (sinscribe --help for details).

Be concise and concrete; reference file paths when you make claims about the code.`,
    rules,
  );
}

// ---------------------------------------------------------------------------
// Spec plan (SDD): requirements → design → tasks → handoff
// ---------------------------------------------------------------------------

export const PLAN_REQUIREMENTS_SECTIONS = `## Objective & users       (what is being built, for whom, and why now — 2-4 sentences)
## Assumptions             (bullets: every assumption you made to fill a gap; end with "Correct any of these before approving.")
## Functional requirements (one "### REQ-n: <title>" per capability, each followed by "- AC-n.m: WHEN <trigger> THE SYSTEM SHALL <observable outcome>" bullets)
## Non-functional requirements (performance, security, accessibility, compatibility — measurable, or "- None beyond the existing baseline.")
## Out of scope            (explicit non-goals; never empty)
## Boundaries              (three bullets: "Always: …", "Ask first: …", "Never: …" — for whoever implements this)
## Success criteria        (how a reviewer knows the whole feature is done — observable, measurable)
## Open questions          (what only a human can decide; each as a question, with your recommended answer)`;

export const PLAN_DESIGN_SECTIONS = `## Overview                (the approach in one paragraph)
## Context read            (leave exactly the line "_Filled in by Sinscribe._" — it is replaced with the files you read)
## Architecture & decisions (one "### D-n: <decision>" per decision, each with "- Choice:", "- Alternatives considered:", "- Why:", "- Serves: REQ-…")
## Data model & DB changes (schemas, migrations, stored state — or "- None.")
## APIs & interfaces affected (endpoints, function signatures, CLI flags, events — new vs changed, with exact names)
## Sequence diagrams       (one or two \`\`\`mermaid sequenceDiagram blocks for the main flows)
## Error handling          (each failure mode and what the system does)
## Testing strategy        (test levels, where tests live, and the repository's exact test/build/lint commands)
## Risks & mitigations     (a table: | Risk | Impact (High/Med/Low) | Mitigation |)
## Traceability            (a table: | REQ | Design elements (D-n, components) |)
## Open questions          (only what blocks implementation; each with a recommended answer)`;

export const PLAN_TASKS_SKELETON = `## Phase 1: <first vertical slice — a user-visible capability, not a layer>

- [ ] T-1: <imperative title>
  - Implements: AC-1.1, AC-1.2
  - Depends on: none
  - Files: \`path/one.ts\`, \`path/two.test.ts\`
  - Acceptance: <what is observably true when done>
  - Verify: \`<exact command>\`
  - Size: S
- [ ] T-2: …
- [ ] Checkpoint: <what a human checks after this phase>

## Phase 2: …

## Coverage matrix

| AC | Tasks |
| --- | --- |
| AC-1.1 | T-1 |`;

export const PLAN_HANDOFF_SECTIONS = `## Current state           (where the implementation stands right now)
## Current task            (the task in progress, or "- None — start with T-1.")
## Decisions               (implementation-level decisions and why; carry the design's key decisions by id)
## Noticed but not touching (out-of-scope findings for later — or "- None.")
## Spec deltas             (proposed changes to requirements/design discovered while building, each awaiting human approval — or "- None.")
## Blockers                (what stops progress and who/what can unblock it — or "- None.")
## Next step               (the single next action for the coding agent)`;

const PLAN_SHARED_RULES = `- Ground every line in the provided context (session context, branch, ticket, commits, changed files, rules, the approved upstream documents, and — when you have tools — the files you read). Never invent files, modules, APIs, commands, or behavior. When something is unknown, say so and turn it into an assumption or an open question.
- Use ids exactly as specified (REQ-n, AC-n.m, D-n, T-n). Never renumber ids that already exist in a previous version.
- Do not write a document title, a date, links to the other plan files, or any heading above the first section — those are added for you.
- Plain markdown only. Respond with ONLY the document: no preamble, no explanation, no trailing remark, no surrounding code fence.`;

function planRevisionRules(options: {
  update?: boolean;
  feedback?: boolean;
}): string {
  return `${options.update ? "- You will receive the previous version of this document. Revise it: keep what is still accurate and every existing id, change what the new input requires, and return the complete document (full replacement, not a patch).\n" : ""}${options.feedback ? "- The developer reviewed the previous version and gave feedback. Apply every point of it; keep everything else that is still accurate.\n" : ""}`;
}

export function createPlanRequirementsSystemPrompt(
  options: { update?: boolean; feedback?: boolean } = {},
  rules: string | null,
): string {
  return appendRules(
    `You are a senior engineer writing the requirements document of a spec-driven plan. It is the contract every later step is checked against: the design must serve it, every task must implement part of it, and the feature is done only when each acceptance criterion is proven. It defines WHAT and WHY — never HOW.

Emit exactly these sections, in this order (replace the parenthetical hints with real content):

${PLAN_REQUIREMENTS_SECTIONS}

Rules:
- Every acceptance criterion is specific, testable and observable. Rewrite vague goals as measurable conditions ("fast" → "responds in < 300 ms for 1k records"). If you cannot make one testable, it is an open question, not a criterion.
- Number requirements REQ-1, REQ-2, … and their criteria AC-<req>.<n> (AC-1.1, AC-1.2, AC-2.1, …). One observable behavior per criterion; cover error and edge cases, not just the happy path.
- Requirements describe behavior a user or caller can observe. Implementation choices (libraries, file layout, schemas) belong to the design, not here.
- Surface every gap you filled as an assumption. Never silently resolve an ambiguity — half of misalignment is silent disagreement about what is NOT being built, so "Out of scope" is mandatory.
- Keep it as short as completeness allows: a small feature gets two or three requirements, not ten.
${planRevisionRules(options)}${PLAN_SHARED_RULES}`,
    rules,
  );
}

export function createPlanDesignSystemPrompt(
  options: { update?: boolean; feedback?: boolean } = {},
  rules: string | null,
): string {
  return appendRules(
    `You are a staff engineer writing the technical design of a spec-driven plan. You receive the APPROVED requirements; your design defines HOW the system will satisfy every one of them, fitted to the code that already exists. Tasks will be cut from this document, so it must be concrete enough to implement and honest about risk.

Emit exactly these sections, in this order (replace the parenthetical hints with real content):

${PLAN_DESIGN_SECTIONS}

Rules:
- Every REQ-n in the requirements must appear in the Traceability table. Never add behavior the requirements do not ask for; if the design needs a requirement change, list it under Open questions instead of silently diverging.
- Fit the existing codebase: reuse its modules, patterns, naming and libraries; name the real files and functions you will extend. Prefer the simplest design that satisfies the requirements — no speculative abstractions.
- For each decision, state the alternatives you rejected and why, so it is not relitigated later.
- Testing strategy must use the repository's real commands (from its package scripts, build files, or contributor docs). Never assume a default like "npm test".
- Mermaid diagrams must be valid sequenceDiagram syntax with short participant names.
- Risks are concrete (what could break, for whom) with a mitigation each; include migration, compatibility, security and rollback where they apply.
${planRevisionRules(options)}${PLAN_SHARED_RULES}`,
    rules,
  );
}

export function createPlanTasksSystemPrompt(
  options: { update?: boolean; feedback?: boolean } = {},
  rules: string | null,
): string {
  return appendRules(
    `You are a tech lead breaking an APPROVED design into the task list a coding agent will execute one task at a time, in order, committing after each. Each task must be small, atomic and verifiable on its own, and the list as a whole must cover every acceptance criterion in the requirements.

Emit this structure (the example shows the exact line format to follow):

${PLAN_TASKS_SKELETON}

Rules:
- Slice vertically: each phase delivers a working, testable capability end to end (data + logic + interface), not a horizontal layer ("all the schemas", "all the endpoints"). Put risky or foundational work first so problems surface early.
- Every task has all six fields — Implements, Depends on, Files, Acceptance, Verify, Size — in exactly the format shown. "Implements" lists the AC ids it satisfies; "Depends on" lists T ids or "none".
- Size is XS (1 file), S (1-2 files) or M (3-5 files). Anything larger must be split. If a title needs "and", it is probably two tasks. Acceptance fits in three bullets or fewer.
- Verify is the exact, runnable command (or the narrowest test filter) that proves this task — using the repository's real commands. Prefer writing the test inside the task it verifies.
- Add a "- [ ] Checkpoint: …" line after every two or three tasks, naming what a human should check.
- Every AC-n.m in the requirements must be implemented by at least one task, and the Coverage matrix must list every AC. Never reference an AC or task id that does not exist.
- Number tasks T-1, T-2, … in execution order. When revising, keep the ids of tasks that still exist so completed work stays checked; give new tasks new ids.
- Leave every checkbox unchecked ("- [ ]"); progress is tracked by the tooling.
${planRevisionRules(options)}${PLAN_SHARED_RULES}`,
    rules,
  );
}

export function createPlanHandoffSystemPrompt(
  options: { update?: boolean; feedback?: boolean } = {},
  rules: string | null,
): string {
  return appendRules(
    `You are writing the living handoff for a spec-driven plan: the memory a coding agent reads at the start of every session and updates after every task, so work survives across sessions and agents. You receive the approved requirements, design and tasks, the git state, and any previous handoff.

Emit exactly these sections, in this order:

${PLAN_HANDOFF_SECTIONS}

Rules:
- Describe the state as it is now. Never claim a task is done unless the commits or the checked tasks show it.
- A status table and an append-only "## Log" are maintained by the tooling around your text — do not write a status table, a progress summary, or a "## Log" section.
- "Next step" names one concrete action, usually "Implement T-n: <title>" for the first unchecked task whose dependencies are done.
- Carry forward every unresolved spec delta, blocker and noticed item from the previous handoff; drop only what is resolved.
- Short bullets, one fact each.
${planRevisionRules(options)}${PLAN_SHARED_RULES}`,
    rules,
  );
}

/** The JSON the session-context draft must return, field by field. */
export const SESSION_DRAFT_SHAPE = `{
  "feature": "the author's direction, kept in their words, then the why and the scope it implies",
  "requirements": "acceptance criteria and business/technical rules found in the evidence, as a markdown list — or null when there is no evidence for any",
  "ticket": "a ticket id that appears literally in the evidence, or null",
  "sources": [{ "path": "repo-relative path you used", "why": "what it contributed" }],
  "openQuestions": ["what the repository cannot answer and the author must decide"]
}`;

export function createSessionDraftSystemPrompt(
  options: { update?: boolean; feedback?: boolean } = {},
  rules: string | null,
): string {
  return appendRules(
    `You help a developer write the session context for the git branch they are about to work on: the business context every later step (PR descriptions, agent prompts, spec plans) is grounded in. The developer gives the direction — what this session is for and what it should achieve. Your job is to back that direction with evidence from the repository, not to decide it.

Return exactly this JSON shape:

${SESSION_DRAFT_SHAPE}

Rules:
- The direction is the author's decision. Keep its intent and wording at the start of "feature"; expand it with the why and the scope, never replace or redirect it.
- Look for evidence related to the direction: source code, and markdown documents such as reports, notes, specs, ADRs, handoffs, READMEs and changelogs that mention the topic or the ticket. Prefer documents the author named.
- Ground every line in the evidence you were given or read. Never invent acceptance criteria, files, APIs or behavior. A criterion you inferred rather than read is written as "Assumption: …".
- List in "sources" only files you actually used, with one short reason each. Never list a file you did not see.
- Whatever the evidence cannot settle — ambiguous scope, conflicting documents, a missing rule — goes to "openQuestions" as a short question the author can answer. Do not resolve it silently.
- What the author states — in the direction or in feedback — is evidence too, and the strongest: every criterion, rule, limit or answer they give goes into "requirements" as its own line, not only into "feature".
- "requirements" is null only when neither the author nor the repository supports a single criterion. Do not pad it.
- Write in the language of the author's direction.
${options.update ? "- You will receive the previous draft. Revise it: keep what is still accurate, change what the new input requires, and return the complete JSON (full replacement, not a patch).\n" : ""}${options.feedback ? '- The author reviewed the previous draft and gave feedback. Apply every point of it. Answers to open questions become requirements or scope and leave "openQuestions"; a changed goal changes "feature".\n' : ""}- ${JSON_ONLY_INSTRUCTION}`,
    rules,
  );
}
