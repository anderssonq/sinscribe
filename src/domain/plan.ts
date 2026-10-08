import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CommandSpec, GlobalFlags } from "../commands.js";
import {
  providerExploreKind,
  resolveConfiguredProvider,
} from "../constants.js";
import { isFileNotFoundError } from "../env.js";
import {
  getCurrentBranch,
  type CommitSubject,
  getRangeSubjects,
  isPathIgnored,
} from "../git/repo.js";
import type { RunCallbacks } from "../llm/events.js";
import { runExplore, type ExploreMode } from "../llm/explore.js";
import { runSingleShot, stripMarkdownFence } from "../llm/single-shot.js";
import { redactSecrets } from "../util/redact.js";
import { CliError } from "./errors.js";
import {
  assembleHandoffBody,
  buildIndexMarkdown,
  buildLoopPrompt,
  buildPlanDocMarkdown,
  computeCoverage,
  computeProgress,
  computeStageViews,
  type CoverageReport,
  extractLog,
  extractPlanDocBody,
  getLegacyPlanDirRel,
  getPlanDir,
  getPlanDirRel,
  hashDoc,
  nextStage,
  parseIndex,
  parseRequirements,
  parseTasks,
  PLAN_FILES,
  PLAN_STAGES,
  type PlanIndex,
  type PlanStageId,
  type PlanStageRecord,
  type PlanTask,
  preserveTaskState,
  type ProgressReport,
  renderStatusZone,
  replaceStatusZone,
  type Requirement,
  STAGE_TITLES,
  type StageView,
  STATUS_ZONE_END,
  STATUS_ZONE_START,
  summarizeProgress,
  UPSTREAM,
} from "./plan-docs.js";
import {
  describeHandoff,
  gatherPromptContext,
  type PromptContext,
} from "./prompt.js";
import {
  createPlanDesignSystemPrompt,
  createPlanHandoffSystemPrompt,
  createPlanRequirementsSystemPrompt,
  createPlanTasksSystemPrompt,
  PLAN_DESIGN_SECTIONS,
  PLAN_HANDOFF_SECTIONS,
  PLAN_REQUIREMENTS_SECTIONS,
  PLAN_TASKS_SKELETON,
} from "./prompts.js";
import { buildRepoBrief } from "./repo-brief.js";
import { describeRulesForDryRun } from "./rules.js";

/**
 * The spec plan (`sinscribe plan`): a gated requirements → design → tasks →
 * handoff pipeline written to .sinscribe/specs/<branch>/, plus a deterministic loop
 * prompt for an external coding agent. This module is the I/O shell around
 * the pure core in plan-docs.ts; every decision about consistency (approval,
 * staleness, coverage, progress) is made there.
 */

type PlanSpec = Extract<CommandSpec, { name: "plan" }>;

export type PlanContext = {
  cwd: string;
  repoRoot: string;
  branch: string;
  /** Absolute plan directory. */
  dir: string;
  /** Repo-relative plan directory, e.g. `.sinscribe/specs/feat-x`. */
  dirRel: string;
  feature: string;
  ticket: string | null;
  baseRef: string | null;
  /** True when .gitignore excludes the plan directory. */
  ignored: boolean;
  base: PromptContext;
};

const NO_CONTEXT_MESSAGE =
  "Spec plan needs a saved session context for this branch (the feature " +
  "and its requirements). Open the menu with `sinscribe` and pick " +
  "Spec plan — it asks for the context first.";

export async function loadPlanContext(cwd: string): Promise<PlanContext> {
  const base = await gatherPromptContext(cwd);
  const branch = await getCurrentBranch(cwd);

  if (base.repoRoot === null) {
    throw new CliError("Spec plan must run inside a git repository.");
  }

  if (branch === null) {
    throw new CliError(
      "Spec plan is per branch — check out a branch first (HEAD is detached).",
    );
  }

  const dir = getPlanDir(base.repoRoot, branch);
  const dirRel = getPlanDirRel(branch);
  const legacyDirRel = await findLegacyPlanDir(base.repoRoot, branch, dir);

  if (legacyDirRel !== null) {
    throw new CliError(legacyPlanMessage(legacyDirRel, dirRel));
  }

  // The plan dir is tracked but sessions are not: a teammate who cloned the repo
  // continues the plan from index.md's recorded feature.
  const feature =
    base.session?.context?.feature ??
    (await readIndexFeature(dir, branch)) ??
    null;

  if (feature === null) {
    throw new CliError(NO_CONTEXT_MESSAGE);
  }

  return {
    cwd,
    repoRoot: base.repoRoot,
    branch,
    dir,
    dirRel,
    feature,
    ticket: base.ticket,
    baseRef: base.baseRef,
    ignored: await isPathIgnored(base.repoRoot, `${dirRel}/index.md`),
    base,
  };
}

/**
 * The pre-.sinscribe/ plan dir (specs/<branch>/) when it holds a plan and the
 * current dir does not. Plans are never moved silently: the files are tracked,
 * so the move belongs in the author's own commit.
 */
async function findLegacyPlanDir(
  repoRoot: string,
  branch: string,
  dir: string,
): Promise<string | null> {
  if ((await readOptional(path.join(dir, PLAN_FILES.index))) !== null) {
    return null;
  }

  const legacyDirRel = getLegacyPlanDirRel(branch);
  const legacyIndex = await readOptional(
    path.join(repoRoot, ...legacyDirRel.split("/"), PLAN_FILES.index),
  );

  return legacyIndex === null ? null : legacyDirRel;
}

function legacyPlanMessage(legacyDirRel: string, dirRel: string): string {
  return (
    `This branch's plan is in ${legacyDirRel}/, but plans now live in ${dirRel}/. ` +
    `Move it with: mkdir -p ${path.posix.dirname(dirRel)} && git mv ${legacyDirRel} ${dirRel}` +
    ` (then rename LOOP_PROMPT.md to loop-prompt.md)`
  );
}

async function readIndexFeature(
  dir: string,
  branch: string,
): Promise<string | null> {
  const raw = await readOptional(path.join(dir, PLAN_FILES.index));
  const index = raw === null ? null : parseIndex(raw);

  return index !== null && index.branch === branch ? index.feature : null;
}

// ---------------------------------------------------------------------------
// Snapshot — everything about the plan on disk, recomputed on every read
// ---------------------------------------------------------------------------

export type PlanSnapshot = {
  index: PlanIndex | null;
  bodies: Partial<Record<PlanStageId, string>>;
  views: Record<PlanStageId, StageView>;
  next: PlanStageId | null;
  /** Set when the directory belongs to another branch (lossy slug collision). */
  conflict: string | null;
  /** Stage files exist but index.md is missing or unreadable. */
  unmanaged: boolean;
  requirements: Requirement[];
  tasks: PlanTask[];
  coverage: CoverageReport | null;
  progress: ProgressReport | null;
  loopPromptExists: boolean;
};

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }

    throw error;
  }
}

/** The git log each snapshot was computed from, so a re-read can skip it. */
const snapshotCommits = new WeakMap<PlanSnapshot, CommitSubject[]>();

/**
 * `commits` reuses an earlier read's git log — only valid when no commit can
 * have landed since and the plan's createdAt (the log's bound) is unchanged.
 */
export async function readPlan(
  ctx: PlanContext,
  commits?: CommitSubject[],
): Promise<PlanSnapshot> {
  const rawIndex = await readOptional(path.join(ctx.dir, PLAN_FILES.index));
  const index = rawIndex === null ? null : parseIndex(rawIndex);
  const bodies: Partial<Record<PlanStageId, string>> = {};

  for (const stage of PLAN_STAGES) {
    const raw = await readOptional(path.join(ctx.dir, PLAN_FILES[stage]));

    if (raw !== null) {
      bodies[stage] = extractPlanDocBody(raw);
    }
  }

  const views = computeStageViews(index, bodies);
  const requirements = parseRequirements(bodies.requirements ?? "");
  const tasks = parseTasks(bodies.tasks ?? "");
  const hasTasks = bodies.tasks !== undefined;
  // Without a base to range from, the plan's creation bounds the history so
  // an earlier plan's [T-n] commits are not attributed to this one.
  const log = !hasTasks
    ? []
    : (commits ??
      (await getRangeSubjects(
        ctx.cwd,
        ctx.baseRef,
        200,
        ctx.baseRef === null ? (index?.createdAt ?? null) : null,
      )));
  const snap: PlanSnapshot = {
    index,
    bodies,
    views,
    next: nextStage(views),
    conflict:
      index !== null && index.branch !== ctx.branch
        ? `${ctx.dirRel} belongs to branch ${index.branch}, not ${ctx.branch}`
        : null,
    unmanaged: index === null && Object.keys(bodies).length > 0,
    requirements,
    tasks,
    coverage: hasTasks ? computeCoverage(requirements, tasks) : null,
    progress: hasTasks ? computeProgress(requirements, tasks, log) : null,
    loopPromptExists:
      (await readOptional(path.join(ctx.dir, PLAN_FILES.loop))) !== null,
  };

  snapshotCommits.set(snap, log);

  return snap;
}

function assertUsable(snap: PlanSnapshot): void {
  if (snap.conflict !== null) {
    throw new CliError(snap.conflict);
  }
}

/** An upstream counts only when approved AND unchanged since approval. */
function upstreamReady(snap: PlanSnapshot, stage: PlanStageId): string | null {
  const upstream = UPSTREAM[stage];

  if (upstream === null) {
    return null;
  }

  const view = snap.views[upstream];

  if (view.status !== "approved" || view.editedSinceApproval) {
    return (
      `Approve ${PLAN_FILES[upstream]} first` +
      (view.editedSinceApproval
        ? " (it was edited after approval — accept the edits)."
        : view.staleBecause
          ? ` (${view.staleBecause}).`
          : ".")
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Stage generation
// ---------------------------------------------------------------------------

export type StageDraft = {
  /** The body, ready to preview (framing is added on write). */
  content: string;
  /** Coverage problems etc. Errors are prefixed "✗" and block approval. */
  warnings: string[];
  /** One-line context note for the review screen. */
  note: string;
  mode: ExploreMode;
  filesRead: string[];
};

export type StageRun = {
  stage: PlanStageId;
  /** The on-disk draft when one exists, so the UI can review it unchanged. */
  existing: StageDraft | null;
  generate(
    feedback: string | null,
    callbacks?: RunCallbacks,
  ): Promise<StageDraft>;
  /** Writes the doc as approved, updates index.md (and loop-prompt.md). */
  approve(): Promise<string[]>;
  /** Writes the doc as a draft (print path, "save as draft"). */
  saveDraft(): Promise<string[]>;
};

export type StageRunOptions = {
  /** False forces single-shot (--no-explore). */
  explore: boolean;
  /** "existing": revise the on-disk version; "fresh": start over. */
  revise: "fresh" | "existing";
};

export function createStageRun(
  ctx: PlanContext,
  snap: PlanSnapshot,
  stage: PlanStageId,
  flags: GlobalFlags,
  options: StageRunOptions,
): StageRun {
  assertUsable(snap);

  const blocked = upstreamReady(snap, stage);

  if (blocked !== null) {
    throw new CliError(blocked);
  }

  const upstream = UPSTREAM[stage];
  const upstreamSha =
    upstream === null ? null : hashDoc(upstream, snap.bodies[upstream] ?? "");
  const onDisk = snap.bodies[stage] ?? null;
  const record = snap.index?.stages[stage] ?? null;
  let last: (StageDraft & { model: string }) | null =
    onDisk !== null && record !== null
      ? { ...reviewOnDisk(snap, stage, onDisk, record), model: record.model }
      : null;
  let previous: string | null = options.revise === "existing" ? onDisk : null;

  const generate = async (
    feedback: string | null,
    callbacks: RunCallbacks = {},
  ): Promise<StageDraft> => {
    // Feedback is always about the draft the developer just reviewed — the
    // on-disk one when a "fresh" run has not generated yet — so revise it
    // rather than starting over without it.
    const base =
      feedback !== null ? (previous ?? last?.content ?? null) : previous;
    const systemPrompt = buildStageSystemPrompt(stage, {
      update: base !== null,
      feedback: feedback !== null,
      rules: ctx.base.rulesSummary.combined,
    });
    const userPrompt = buildStageUserPrompt(ctx, snap, stage, base, feedback);
    const llm = {
      modelId: flags.modelId,
      provider: flags.provider,
      apiKey: flags.apiKey,
      debug: callbacks.debug,
      onEvent: callbacks.onEvent,
    };
    // Requirements and design ground themselves in the code; tasks only
    // need the repo brief (real paths and commands); the handoff works from
    // the documents alone.
    const result =
      stage === "handoff"
        ? {
            ...(await runSingleShot(systemPrompt, userPrompt, llm)),
            mode: "single-shot" as const,
            filesRead: [],
            fallbackReason: null,
          }
        : await runExplore(systemPrompt, userPrompt, {
            ...llm,
            repoRoot: ctx.repoRoot,
            explore:
              options.explore &&
              (stage === "requirements" || stage === "design"),
            singleShotReason:
              stage === "tasks"
                ? "tasks are cut from the approved design + repo brief"
                : undefined,
            fallbackContext: () => buildRepoBrief(ctx.repoRoot),
          });
    const raw = stripMarkdownFence(result.text);

    if (raw.length === 0) {
      throw new CliError("The model produced no output.");
    }

    const draft = postProcess(ctx, snap, stage, raw, {
      mode: result.mode,
      filesRead: result.filesRead,
      fallbackReason: result.fallbackReason,
    });

    last = { ...draft, model: result.modelId };
    previous = draft.content;

    return draft;
  };

  const write = async (
    status: PlanStageRecord["status"],
  ): Promise<string[]> => {
    if (last === null) {
      throw new Error("approve() called before a successful generate().");
    }

    const blocking = last.warnings.filter((line) => line.startsWith("✗"));

    if (status === "approved" && blocking.length > 0) {
      throw new CliError(
        `Cannot approve ${PLAN_FILES[stage]}:\n${blocking.join("\n")}`,
      );
    }

    const now = new Date().toISOString();

    await mkdir(ctx.dir, { recursive: true });
    await writeFile(
      path.join(ctx.dir, PLAN_FILES[stage]),
      buildPlanDocMarkdown({
        stage,
        branch: ctx.branch,
        feature: ctx.feature,
        body: last.content,
      }),
      "utf8",
    );

    const recordOut: PlanStageRecord = {
      status,
      generatedAt: now,
      approvedAt: status === "approved" ? now : null,
      sha: hashDoc(stage, last.content),
      upstreamSha,
      mode: last.mode,
      model: last.model,
    };

    return finishWrite(ctx, stage, recordOut, status);
  };

  return {
    stage,
    existing: onDisk !== null && record?.status === "draft" ? last : null,
    generate,
    approve: () => write("approved"),
    saveDraft: () => write("draft"),
  };
}

/**
 * The on-disk version as a reviewable draft: warnings only, content as is
 * (it was post-processed when it was generated; re-running that would, e.g.,
 * wipe design's real "Context read" list).
 */
function reviewOnDisk(
  snap: PlanSnapshot,
  stage: PlanStageId,
  body: string,
  record: PlanStageRecord,
): StageDraft {
  const warnings =
    stage === "tasks"
      ? (() => {
          const coverage = computeCoverage(snap.requirements, parseTasks(body));

          return [
            ...coverage.errors.map((error) => `✗ ${error}`),
            ...coverage.warnings,
          ];
        })()
      : [];

  return {
    content: body,
    warnings,
    note: `saved ${record.status} · ${record.mode} · ${record.model}`,
    mode: modeOf(record),
    filesRead: [],
  };
}

function modeOf(record: PlanStageRecord): ExploreMode {
  return record.mode === "claude-cli-readonly" ||
    record.mode === "kiro-cli-readonly" ||
    record.mode === "agent-readonly"
    ? record.mode
    : "single-shot";
}

/** Stage-specific, deterministic finishing of a model-written body. */
function postProcess(
  ctx: PlanContext,
  snap: PlanSnapshot,
  stage: PlanStageId,
  raw: string,
  meta: {
    mode: ExploreMode;
    filesRead: string[];
    fallbackReason?: string | null;
  },
): StageDraft {
  const { text, count } = redactSecrets(raw);
  const warnings: string[] = [];
  let content = text;

  if (count > 0) {
    warnings.push(`redacted ${count} secret-looking value(s)`);
  }

  if (stage === "design") {
    content = replaceSection(content, "Context read", describeFilesRead(meta));
  }

  if (stage === "tasks") {
    const preserved = preserveTaskState(snap.tasks, content);

    content = preserved.markdown;

    for (const id of preserved.dropped) {
      warnings.push(`${id} was done but no longer exists in the new list`);
    }

    const coverage = computeCoverage(snap.requirements, parseTasks(content));

    warnings.push(
      ...coverage.errors.map((error) => `✗ ${error}`),
      ...coverage.warnings,
    );
  }

  if (stage === "handoff") {
    const tasks = snap.tasks;
    const progress =
      snap.progress ?? computeProgress(snap.requirements, tasks, []);
    const previousLog = extractLog(snap.bodies.handoff ?? "");

    content = assembleHandoffBody({
      statusZone: renderStatusZone(tasks, progress),
      narrative: stripStatusZone(content),
      previousLog,
    });
  }

  return {
    content,
    warnings,
    note: describeMode(meta),
    mode: meta.mode,
    filesRead: meta.filesRead,
  };
}

function describeMode(meta: {
  mode: ExploreMode;
  filesRead: string[];
  fallbackReason?: string | null;
}): string {
  if (meta.mode === "single-shot") {
    return meta.fallbackReason
      ? `single-shot — ${meta.fallbackReason}`
      : "single-shot";
  }

  return `explored the repo read-only · ${meta.filesRead.length} file(s) read`;
}

function describeFilesRead(meta: {
  mode: ExploreMode;
  filesRead: string[];
  fallbackReason?: string | null;
}): string {
  if (meta.filesRead.length === 0) {
    return meta.mode === "single-shot"
      ? "_Drafted without opening files (single-shot): based on the tracked file list, package scripts and root rule docs._"
      : "_The model explored the repository but opened no files._";
  }

  const shown = meta.filesRead.slice(0, 40).map((file) => `- \`${file}\``);
  const more =
    meta.filesRead.length > shown.length
      ? [`- … and ${meta.filesRead.length - shown.length} more`]
      : [];

  return [
    `Files read while drafting this design (${meta.filesRead.length}):`,
    ...shown,
    ...more,
  ].join("\n");
}

/** Replaces a `## <title>` section's content up to the next `## ` heading. */
export function replaceSection(
  markdown: string,
  title: string,
  content: string,
): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^##\\s+${title}\\b`, "u").test(line),
  );

  if (start === -1) {
    return markdown;
  }

  let end = start + 1;

  while (end < lines.length && !/^##\s/u.test(lines[end])) {
    end += 1;
  }

  return [...lines.slice(0, start + 1), content, "", ...lines.slice(end)].join(
    "\n",
  );
}

function stripStatusZone(text: string): string {
  const start = text.indexOf(STATUS_ZONE_START);
  const end = text.indexOf(STATUS_ZONE_END);

  return start !== -1 && end > start
    ? text.slice(0, start) + text.slice(end + STATUS_ZONE_END.length)
    : text;
}

function buildStageSystemPrompt(
  stage: PlanStageId,
  options: { update: boolean; feedback: boolean; rules: string | null },
): string {
  const flags = { update: options.update, feedback: options.feedback };

  switch (stage) {
    case "requirements":
      return createPlanRequirementsSystemPrompt(flags, options.rules);
    case "design":
      return createPlanDesignSystemPrompt(flags, options.rules);
    case "tasks":
      return createPlanTasksSystemPrompt(flags, options.rules);
    case "handoff":
      return createPlanHandoffSystemPrompt(flags, options.rules);
  }
}

/** Which approved documents each stage is generated from. */
const STAGE_INPUTS: Record<PlanStageId, PlanStageId[]> = {
  requirements: [],
  design: ["requirements"],
  tasks: ["requirements", "design"],
  handoff: ["requirements", "design", "tasks"],
};

function buildStageUserPrompt(
  ctx: PlanContext,
  snap: PlanSnapshot,
  stage: PlanStageId,
  previous: string | null,
  feedback: string | null,
): string {
  const session = ctx.base.session?.context ?? null;
  const upstreamDocs = STAGE_INPUTS[stage].map((input) =>
    [
      "",
      `===== APPROVED ${PLAN_FILES[input]} =====`,
      snap.bodies[input] ?? "(missing)",
      `===== END ${PLAN_FILES[input]} =====`,
    ].join("\n"),
  );
  // The handoff is a living document: even a "fresh" regeneration must see
  // the previous narrative (unresolved deltas and blockers carry forward)
  // and the agent's log, which is the implementation's actual memory.
  const handoffSource =
    stage === "handoff" ? (previous ?? snap.bodies.handoff ?? null) : null;
  const previousBody =
    handoffSource !== null
      ? stripStatusZone(handoffSource)
          .replace(/^## Log[\s\S]*$/mu, "")
          .trim()
      : previous;
  const agentLog = handoffSource !== null ? extractLog(handoffSource) : null;

  return [
    `Repository branch: ${ctx.branch}`,
    `Target/base branch: ${ctx.baseRef ?? "(unknown)"}`,
    ctx.ticket ? `Ticket: ${ctx.ticket}` : null,
    "",
    "Feature context (saved by the developer for this branch — the source of the requirements):",
    `Feature: ${session?.feature ?? ctx.feature}`,
    session?.ticket ? `Ticket: ${session.ticket}` : null,
    session?.requirements
      ? `Requirements notes:\n${session.requirements}`
      : null,
    describeHandoff(ctx.base.handoff, ctx.base.branch),
    "",
    "Commits already on this branch:",
    ctx.base.log || "(none yet)",
    ctx.base.changedFiles
      ? ["", "Files changed vs the base branch:", ctx.base.changedFiles].join(
          "\n",
        )
      : null,
    ...upstreamDocs,
    previousBody
      ? [
          "",
          stage === "handoff"
            ? "Previous handoff narrative (may be outdated — the task state below wins):"
            : `Previous version of ${PLAN_FILES[stage]} (revise it; keep its ids):`,
          previousBody,
        ].join("\n")
      : null,
    agentLog && /^### /mu.test(agentLog)
      ? [
          "",
          "Implementation log written by the coding agent (facts — what was actually done and verified):",
          agentLog,
        ].join("\n")
      : null,
    // Last on purpose: the most authoritative facts go where models weigh
    // them most, after everything they override.
    stage === "handoff" ? describeTaskState(snap) : null,
    feedback
      ? [
          "",
          "Developer feedback on the previous version (apply all of it):",
          feedback,
        ].join("\n")
      : null,
    "",
    `Write ${PLAN_FILES[stage]} now.`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** The checkbox truth from tasks.md, stated so the narrative cannot drift. */
function describeTaskState(snap: PlanSnapshot): string {
  const done = snap.tasks.filter((task) => task.done).map((task) => task.id);

  return [
    "",
    "AUTHORITATIVE task state from tasks.md (overrides the previous handoff and any assumption):",
    snap.progress ? `- ${summarizeProgress(snap.progress)}` : "- No tasks yet.",
    `- Done (checked): ${done.length > 0 ? done.join(", ") : "none"}`,
    snap.progress?.next
      ? `- Next: ${snap.progress.next.id}: ${snap.progress.next.title}`
      : "- Next: none — every task is checked; the final AC verification is next.",
    "- A checked task is done even when its changes are uncommitted (the rules may forbid commits).",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Writing state
// ---------------------------------------------------------------------------

async function finishWrite(
  ctx: PlanContext,
  stage: PlanStageId,
  record: PlanStageRecord,
  status: PlanStageRecord["status"],
): Promise<string[]> {
  const snap = await readPlan(ctx);
  const now = new Date().toISOString();
  const index: PlanIndex = snap.index ?? {
    version: 1,
    branch: ctx.branch,
    feature: ctx.feature,
    ticket: ctx.ticket,
    baseRef: ctx.baseRef,
    createdAt: now,
    updatedAt: now,
    stages: {},
  };

  index.stages[stage] = record;
  index.updatedAt = now;

  const lines = [
    `${status === "approved" ? "Approved" : "Saved draft"} ${ctx.dirRel}/${PLAN_FILES[stage]}`,
  ];

  if (status === "approved" && (stage === "tasks" || stage === "handoff")) {
    await writeFile(
      path.join(ctx.dir, PLAN_FILES.loop),
      buildLoopPrompt({
        dirRel: ctx.dirRel,
        branch: ctx.branch,
        feature: ctx.feature,
      }),
      "utf8",
    );
    lines.push(`Wrote ${ctx.dirRel}/${PLAN_FILES.loop}`);
  }

  const after = await writeIndex(ctx, index, snap);
  const downstream = PLAN_STAGES.filter(
    (other) => after.views[other].status === "stale",
  );

  if (downstream.length > 0) {
    lines.push(
      `Now stale: ${downstream.map((other) => PLAN_FILES[other]).join(", ")} — regenerate in order.`,
    );
  }

  if (after.next !== null) {
    lines.push(`Next: ${STAGE_TITLES[after.next]} (${PLAN_FILES[after.next]})`);
  } else {
    lines.push(
      `Plan approved. Hand ${ctx.dirRel}/${PLAN_FILES.loop} to your coding agent; run \`sinscribe plan --sync\` as work lands.`,
    );
  }

  return lines;
}

/** Writes index.md from the given state and returns the fresh snapshot. */
async function writeIndex(
  ctx: PlanContext,
  index: PlanIndex,
  /** A snapshot read after the stage files were written, to skip a re-read. */
  current?: PlanSnapshot,
): Promise<PlanSnapshot> {
  // Views depend on index + bodies, so compute them against the new index.
  const interim = current ?? (await readPlan(ctx));
  const views = computeStageViews(index, interim.bodies);

  await mkdir(ctx.dir, { recursive: true });
  await writeFile(
    path.join(ctx.dir, PLAN_FILES.index),
    buildIndexMarkdown({
      index,
      views,
      progress: interim.progress,
      coverage: interim.coverage,
      dirRel: ctx.dirRel,
    }),
    "utf8",
  );

  // Writing files lands no commit: reuse the log when its bound is the same.
  return readPlan(
    ctx,
    interim.index?.createdAt === index.createdAt
      ? snapshotCommits.get(interim)
      : undefined,
  );
}

/**
 * Offline approval (no model, no credentials): approves the on-disk draft of
 * a stage, or re-records a hand-edited approved stage ("accept edits").
 */
export async function approveStage(
  ctx: PlanContext,
  stage: PlanStageId | null,
): Promise<string[]> {
  const snap = await readPlan(ctx);

  assertUsable(snap);

  const target =
    stage ??
    PLAN_STAGES.find(
      (candidate) =>
        snap.views[candidate].status === "draft" ||
        snap.views[candidate].editedSinceApproval,
    ) ??
    null;

  if (target === null || snap.index === null) {
    throw new CliError("Nothing to approve — no draft or edited stage found.");
  }

  const record = snap.index.stages[target];
  const body = snap.bodies[target];

  if (record === undefined || body === undefined) {
    throw new CliError(`${PLAN_FILES[target]} has not been generated yet.`);
  }

  const view = snap.views[target];
  // Hand edits made alongside an upstream's (accepted first, in plan order)
  // are the developer's own consistent revision: rebase them onto the
  // upstream as it now stands instead of calling them stale.
  const acceptingEdits =
    view.editedSinceApproval && upstreamReady(snap, target) === null;
  const upstream = UPSTREAM[target];
  const upstreamBody = upstream === null ? undefined : snap.bodies[upstream];

  if (view.status === "stale" && !acceptingEdits) {
    throw new CliError(
      `${PLAN_FILES[target]} is stale (${view.staleBecause ?? "upstream changed"}) — regenerate it instead.`,
    );
  }

  if (target === "tasks" && snap.coverage && snap.coverage.errors.length > 0) {
    throw new CliError(
      `Cannot approve ${PLAN_FILES.tasks}:\n${snap.coverage.errors.map((error) => `✗ ${error}`).join("\n")}`,
    );
  }

  const now = new Date().toISOString();

  return finishWrite(
    ctx,
    target,
    {
      ...record,
      status: "approved",
      approvedAt: now,
      sha: hashDoc(target, body),
      upstreamSha:
        acceptingEdits && upstream !== null && upstreamBody !== undefined
          ? hashDoc(upstream, upstreamBody)
          : record.upstreamSha,
    },
    "approved",
  );
}

/**
 * Deterministic progress sync (no model): matches `[T-n]` commits and task
 * checkboxes, rewrites the handoff's status zone (never its log) and the
 * index's progress section, and reports what it found.
 */
export async function syncPlan(ctx: PlanContext): Promise<string[]> {
  const snap = await readPlan(ctx);

  assertUsable(snap);

  if (snap.index === null || snap.progress === null) {
    throw new CliError(
      `No approved tasks in ${ctx.dirRel} yet — nothing to sync.`,
    );
  }

  const lines = [summarizeProgress(snap.progress)];
  const handoffPath = path.join(ctx.dir, PLAN_FILES.handoff);
  const rawHandoff = await readOptional(handoffPath);

  if (rawHandoff !== null) {
    const replaced = replaceStatusZone(
      rawHandoff,
      renderStatusZone(snap.tasks, snap.progress),
    );

    if (replaced === null) {
      lines.push(
        `⚠ ${PLAN_FILES.handoff} lost its status markers — left untouched; regenerate the handoff to restore them.`,
      );
    } else {
      await writeFile(handoffPath, replaced, "utf8");
      lines.push(`Updated status in ${ctx.dirRel}/${PLAN_FILES.handoff}`);
    }
  }

  const after = await writeIndex(ctx, {
    ...snap.index,
    updatedAt: new Date().toISOString(),
  });
  const partial = snap.progress.acs.filter((ac) => ac.state === "partial");
  const uncovered = snap.progress.acs.filter((ac) => ac.state === "uncovered");

  if (partial.length > 0) {
    lines.push(`In progress: ${partial.map((ac) => ac.id).join(", ")}`);
  }

  if (uncovered.length > 0) {
    lines.push(`⚠ No task covers: ${uncovered.map((ac) => ac.id).join(", ")}`);
  }

  for (const issue of snap.progress.inconsistencies.slice(0, 5)) {
    lines.push(`⚠ ${issue}`);
  }

  if (snap.progress.done === snap.progress.total && snap.progress.total > 0) {
    lines.push(
      "All tasks are checked — have the agent run the final AC verification (see loop-prompt.md §3).",
    );
  } else if (snap.progress.next) {
    lines.push(
      `Next task: ${snap.progress.next.id}: ${snap.progress.next.title}`,
    );
  }

  if (after.next !== null && after.next !== "handoff") {
    lines.push(
      `⚠ ${PLAN_FILES[after.next]} is ${after.views[after.next].status} — the agent should not build on it.`,
    );
  }

  return lines;
}

/** Deletes the plan's own files (tracked in git, so recoverable). */
export async function resetPlan(ctx: PlanContext): Promise<void> {
  for (const file of Object.values(PLAN_FILES)) {
    await rm(path.join(ctx.dir, file), { force: true });
  }
}

export async function readLoopPrompt(ctx: PlanContext): Promise<string> {
  const content = await readOptional(path.join(ctx.dir, PLAN_FILES.loop));

  if (content === null) {
    throw new CliError(
      `${ctx.dirRel}/${PLAN_FILES.loop} does not exist yet — approve tasks.md first.`,
    );
  }

  return content;
}

// ---------------------------------------------------------------------------
// Menu badge, dry run, print path
// ---------------------------------------------------------------------------

export type PlanMenuSummary = {
  approved: number;
  tasksDone: number;
  tasksTotal: number;
};

/** Cheap: index + tasks.md only, no git. Null when there is no plan. */
export async function summarizePlanForMenu(
  repoRoot: string,
  branch: string,
): Promise<PlanMenuSummary | null> {
  const dir = getPlanDir(repoRoot, branch);
  const rawIndex = await readOptional(path.join(dir, PLAN_FILES.index));
  const index = rawIndex === null ? null : parseIndex(rawIndex);

  if (index === null || index.branch !== branch) {
    return null;
  }

  const rawTasks = await readOptional(path.join(dir, PLAN_FILES.tasks));
  const tasks =
    rawTasks === null ? [] : parseTasks(extractPlanDocBody(rawTasks));

  return {
    approved: PLAN_STAGES.filter(
      (stage) => index.stages[stage]?.status === "approved",
    ).length,
    tasksDone: tasks.filter((task) => task.done).length,
    tasksTotal: tasks.length,
  };
}

const STAGE_SKELETONS: Record<PlanStageId, string> = {
  requirements: PLAN_REQUIREMENTS_SECTIONS,
  design: PLAN_DESIGN_SECTIONS,
  tasks: PLAN_TASKS_SKELETON,
  handoff: PLAN_HANDOFF_SECTIONS,
};

export async function dryRunPlan(
  spec: PlanSpec,
  flags: GlobalFlags | null,
  cwd: string,
): Promise<string> {
  const base = await gatherPromptContext(cwd);
  const branch = await getCurrentBranch(cwd);
  const header = "sinscribe plan (dry run: no LLM call, no credentials read)";

  if (base.repoRoot === null || branch === null) {
    return [header, "", "Not on a branch inside a git repository."].join("\n");
  }

  const dirRel = getPlanDirRel(branch);
  const contextLine = base.session?.context?.feature
    ? `saved (${previewText(base.session.context.feature)})`
    : "(missing — required; set it from the menu first)";
  const ctx: PlanContext = {
    cwd,
    repoRoot: base.repoRoot,
    branch,
    dir: getPlanDir(base.repoRoot, branch),
    dirRel,
    feature: base.session?.context?.feature ?? "",
    ticket: base.ticket,
    baseRef: base.baseRef,
    ignored: await isPathIgnored(base.repoRoot, `${dirRel}/index.md`),
    base,
  };
  const legacyDirRel = await findLegacyPlanDir(base.repoRoot, branch, ctx.dir);

  if (legacyDirRel !== null) {
    return [header, "", legacyPlanMessage(legacyDirRel, dirRel)].join("\n");
  }

  const snap = await readPlan(ctx);
  const stage = spec.stage ?? snap.next;
  // Flags/env only: a dry run never loads ~/.sinscribe/.env.
  const provider = resolveConfiguredProvider(flags?.provider ?? null);
  const exploreKind = providerExploreKind(provider);
  const explores =
    spec.explore &&
    exploreKind !== "none" &&
    (stage === "requirements" || stage === "design");
  const stageLines = PLAN_STAGES.map((id) => {
    const view = snap.views[id];

    return `  ${STAGE_TITLES[id].padEnd(13)}${view.status}${view.editedSinceApproval ? " (edited since approval)" : ""}${view.staleBecause ? ` — ${view.staleBecause}` : ""}`;
  });
  const action =
    spec.action === "generate"
      ? stage === null
        ? "nothing — every stage is approved"
        : `generate ${PLAN_FILES[stage]} (${explores ? `explore read-only via ${exploreKind}` : "single-shot"}; provider ${provider} from flags/env)`
      : spec.action;

  return [
    header,
    "",
    `Branch:      ${branch}`,
    `Base:        ${base.baseRef ?? "(none detected)"}`,
    `Context:     ${contextLine}`,
    `Rules:       ${describeRulesForDryRun(base.rulesSummary)}`,
    `Plan dir:    ${dirRel}/ (${ctx.ignored ? "gitignored" : "tracked by git — commit it with the work"})`,
    snap.conflict ? `Conflict:    ${snap.conflict}` : null,
    "Stages:",
    ...stageLines,
    snap.progress ? `Progress:    ${summarizeProgress(snap.progress)}` : null,
    `Action:      ${action}`,
    stage !== null && spec.action === "generate"
      ? [
          "",
          `The model would emit ${PLAN_FILES[stage]} with this structure:`,
          "---",
          STAGE_SKELETONS[stage],
          "---",
        ].join("\n")
      : null,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function previewText(text: string): string {
  const singleLine = text.replace(/\s+/gu, " ").trim();

  return singleLine.length > 60 ? `${singleLine.slice(0, 57)}...` : singleLine;
}

/** Print / non-TTY path: never approves on its own — a draft waits for --approve. */
export async function runPlan(
  spec: PlanSpec,
  flags: GlobalFlags,
  cwd: string,
  callbacks: RunCallbacks = {},
): Promise<string> {
  const ctx = await loadPlanContext(cwd);

  switch (spec.action) {
    case "approve":
      return (await approveStage(ctx, spec.stage)).join("\n");
    case "sync":
      return (await syncPlan(ctx)).join("\n");
    case "loop-prompt":
      return readLoopPrompt(ctx);
    case "generate":
      break;
  }

  const snap = await readPlan(ctx);

  assertUsable(snap);

  if (snap.unmanaged) {
    throw new CliError(
      `${ctx.dirRel} has plan files but no readable index.md — move them aside or start a new plan from the menu.`,
    );
  }

  const stage = spec.stage ?? snap.next;

  if (stage === null) {
    return [
      "Every stage is approved.",
      "`sinscribe plan --sync` reports progress; `sinscribe plan --loop-prompt` prints the agent contract.",
    ].join("\n");
  }

  // "Next" because it was hand-edited after approval: regenerating would
  // drop the edits and overwrite the file. Accept them, or revise them.
  if (
    spec.stage === null &&
    spec.feedback === null &&
    snap.views[stage].editedSinceApproval
  ) {
    return [
      `${ctx.dirRel}/${PLAN_FILES[stage]} was edited after approval.`,
      `Accept the edits with: sinscribe plan --approve --stage ${stage}`,
      `or revise them with: sinscribe plan --stage ${stage} --feedback "…"`,
    ].join("\n");
  }

  const run = createStageRun(ctx, snap, stage, flags, {
    explore: spec.explore,
    revise: spec.feedback !== null ? "existing" : "fresh",
  });
  const draft = await run.generate(spec.feedback, callbacks);
  const lines = await run.saveDraft();

  return [
    ...lines.filter((line) => !line.startsWith("Next:")),
    `Context: ${draft.note}`,
    ...draft.warnings.map((warning) => `  ${warning}`),
    "",
    `Review ${ctx.dirRel}/${PLAN_FILES[stage]}, then approve it with:`,
    `  sinscribe plan --approve --stage ${stage}`,
    `or revise it with: sinscribe plan --stage ${stage} --feedback "…"`,
  ].join("\n");
}
