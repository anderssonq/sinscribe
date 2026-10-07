import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { GlobalFlags } from "../commands.js";
import {
  approveStage,
  createStageRun,
  loadPlanContext,
  type PlanContext,
  type PlanSnapshot,
  readLoopPrompt,
  readPlan,
  resetPlan,
  type StageRun,
  syncPlan,
} from "../domain/plan.js";
import {
  PLAN_FILES,
  PLAN_STAGES,
  type PlanStageId,
  STAGE_TITLES,
  summarizeProgress,
} from "../domain/plan-docs.js";
import { copyToClipboard } from "../util/clipboard.js";
import { DocReviewFlow, type DocReviewOutcome } from "./doc-review.js";
import { SelectList } from "./menu-view.js";
import { TailPanel } from "./panel.js";
import { useReviewPreviewRows } from "./review-shared.js";
import { getErrorMessage } from "./shared.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";
import { useViewport } from "./viewport.js";

export type PlanFlowOutcome =
  | { status: "done"; summary: string[] }
  | { status: "cancelled"; summary: string[] }
  | { status: "failed"; message: string };

type Step =
  | { step: "loading" }
  | { step: "menu"; notice: string | null }
  | { step: "regen-pick" }
  | { step: "regen-mode"; stage: PlanStageId }
  | { step: "confirm-reset" }
  | { step: "report"; title: string; lines: string[] }
  | {
      step: "stage";
      stage: PlanStageId;
      run: StageRun;
      explore: boolean;
      revise: "fresh" | "existing";
      /** Review the saved draft first instead of generating. */
      useExisting: boolean;
      nonce: number;
    }
  | { step: "final" }
  | { step: "busy"; label: string };

/** Summary lines handed to the host; the menu's result view is not windowed. */
const MAX_SUMMARY_LINES = 8;
/** SelectList chrome: title, two borders, two scroll indicators, footer. */
const SELECT_LIST_CHROME = 6;
/** Report screen chrome: title, panel borders and note, one-item list. */
const REPORT_EXTRA_ROWS = 11;

type PlanFlowProps = {
  flags: GlobalFlags;
  isActive: boolean;
  /** False starts every stage single-shot (--no-explore). */
  explore: boolean;
  /** Jump straight to this stage (--stage), skipping the plan menu. */
  startStage: PlanStageId | null;
  onDone: (outcome: PlanFlowOutcome) => void;
};

/**
 * The spec plan's interactive driver: the existing-plan menu, then each
 * stage through DocReviewFlow, advancing on approval, then the loop prompt.
 * State always comes from disk (readPlan) — this component holds only
 * navigation, so leaving and coming back loses nothing.
 */
export function PlanFlow({
  flags,
  isActive,
  explore,
  startStage,
  onDone,
}: PlanFlowProps) {
  const [step, setStep] = useState<Step>({ step: "loading" });
  const ctxRef = useRef<PlanContext | null>(null);
  const snapRef = useRef<PlanSnapshot | null>(null);
  const summaryRef = useRef<string[]>([]);
  const doneRef = useRef(false);
  const nonceRef = useRef(0);
  const reportRows = useReviewPreviewRows(REPORT_EXTRA_ROWS);
  const { contentRows } = useViewport();

  function finish(outcome: PlanFlowOutcome): void {
    if (doneRef.current) {
      return;
    }

    doneRef.current = true;
    setTimeout(() => {
      onDone(outcome);
    }, 0);
  }

  function note(lines: string[]): void {
    summaryRef.current = [...summaryRef.current, ...lines].slice(
      -MAX_SUMMARY_LINES,
    );
  }

  function summary(): string[] {
    return summaryRef.current.length > 0
      ? summaryRef.current
      : ["No plan files were changed."];
  }

  async function refresh(): Promise<PlanSnapshot> {
    const snap = await readPlan(ctxRef.current as PlanContext);

    snapRef.current = snap;

    return snap;
  }

  function openStage(
    stage: PlanStageId,
    options: {
      explore: boolean;
      revise: "fresh" | "existing";
      useExisting: boolean;
    },
  ): void {
    try {
      const run = createStageRun(
        ctxRef.current as PlanContext,
        snapRef.current as PlanSnapshot,
        stage,
        flags,
        { explore: options.explore, revise: options.revise },
      );

      nonceRef.current += 1;
      setStep({
        step: "stage",
        stage,
        run,
        explore: options.explore,
        revise: options.revise,
        // A stale draft was written against an older upstream: regenerate.
        useExisting:
          options.useExisting &&
          run.existing !== null &&
          snapRef.current?.views[stage].status === "draft",
        nonce: nonceRef.current,
      });
    } catch (error) {
      setStep({ step: "menu", notice: getErrorMessage(error) });
    }
  }

  async function afterStage(outcome: DocReviewOutcome): Promise<void> {
    if (outcome.status !== "cancelled") {
      note(outcome.summary.filter((line) => !line.startsWith("Next:")));
    }

    const snap = await refresh();

    if (outcome.status === "approved") {
      if (snap.next === null) {
        setStep({ step: "final" });
      } else {
        openStage(snap.next, { explore, revise: "fresh", useExisting: true });
      }

      return;
    }

    setStep({ step: "menu", notice: null });
  }

  async function runAction(
    label: string,
    action: () => Promise<string[]>,
    title: string,
  ): Promise<void> {
    setStep({ step: "busy", label });

    try {
      const lines = await action();

      note(lines.slice(0, 2));
      await refresh();
      setStep({ step: "report", title, lines });
    } catch (error) {
      await refresh();
      setStep({ step: "menu", notice: getErrorMessage(error) });
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        ctxRef.current = await loadPlanContext(process.cwd());

        const snap = await refresh();

        if (snap.conflict !== null) {
          finish({ status: "failed", message: snap.conflict });
          return;
        }

        const anyStage = PLAN_STAGES.some(
          (stage) => snap.views[stage].status !== "missing",
        );

        if (startStage !== null) {
          openStage(startStage, {
            explore,
            revise: "fresh",
            useExisting: true,
          });
        } else if (!anyStage && !snap.unmanaged) {
          openStage("requirements", {
            explore,
            revise: "fresh",
            useExisting: false,
          });
        } else {
          setStep({ step: "menu", notice: null });
        }
      } catch (error) {
        finish({ status: "failed", message: getErrorMessage(error) });
      }
    })();
    // Mount-only: the flow drives itself through step transitions.
  }, []);

  const ctx = ctxRef.current;
  const snap = snapRef.current;

  if (
    step.step === "loading" ||
    step.step === "busy" ||
    ctx === null ||
    snap === null
  ) {
    return (
      <Spinner
        label={step.step === "busy" ? step.label : "Reading the spec plan..."}
      />
    );
  }

  if (step.step === "stage") {
    const { stage, run } = step;

    return (
      <DocReviewFlow
        approve={() => run.approve()}
        approveLabel={`Approve ${PLAN_FILES[stage]}`}
        generate={(feedback, callbacks) => run.generate(feedback, callbacks)}
        generatingLabel={generatingLabel(stage, step.explore)}
        initialDraft={step.useExisting ? run.existing : null}
        isActive={isActive}
        key={`${stage}-${step.nonce}`}
        onDone={(outcome) => {
          void afterStage(outcome);
        }}
        onRetryWithoutExplore={
          step.explore && (stage === "requirements" || stage === "design")
            ? () => {
                openStage(stage, {
                  explore: false,
                  revise: step.revise,
                  useExisting: false,
                });
              }
            : undefined
        }
        refinePlaceholder={REFINE_PLACEHOLDERS[stage]}
        saveDraft={() => run.saveDraft()}
        stepper={buildStepper(snap, stage)}
        title={`${STAGE_TITLES[stage]} — ${ctx.dirRel}/${PLAN_FILES[stage]}`}
      />
    );
  }

  if (step.step === "report") {
    return (
      <Box flexDirection="column">
        <Text color={theme.accent}>{step.title}</Text>
        {reportRows !== null ? (
          <TailPanel maxRows={reportRows} text={step.lines.join("\n")} />
        ) : (
          <Text dimColor wrap="truncate-end">
            {step.lines[0] ?? ""}
          </Text>
        )}
        <SelectList
          isActive={isActive}
          items={[
            { id: "back", label: "Back", hint: "return to the plan menu" },
          ]}
          key="plan-report"
          onCancel={() => {
            setStep({ step: "menu", notice: null });
          }}
          onSelect={() => {
            setStep({ step: "menu", notice: null });
          }}
          title="Done"
        />
      </Box>
    );
  }

  if (step.step === "regen-pick") {
    return (
      <SelectList
        isActive={isActive}
        items={[
          ...PLAN_STAGES.filter(
            (stage) => snap.views[stage].status !== "missing",
          ).map((stage) => ({
            id: stage,
            label: `${STAGE_TITLES[stage]} (${snap.views[stage].status})`,
            hint:
              stage === "handoff"
                ? "refresh the narrative; the log is kept"
                : "everything after it becomes stale until regenerated",
          })),
          { id: "back", label: "Back", hint: "return to the plan menu" },
        ]}
        key="plan-regen-pick"
        onCancel={() => {
          setStep({ step: "menu", notice: null });
        }}
        onSelect={(id) => {
          if (id === "back") {
            setStep({ step: "menu", notice: null });
          } else {
            setStep({ step: "regen-mode", stage: id as PlanStageId });
          }
        }}
        title="Regenerate which stage?"
      />
    );
  }

  if (step.step === "regen-mode") {
    const { stage } = step;

    return (
      <SelectList
        isActive={isActive}
        items={[
          {
            id: "existing",
            label: "Revise the current version",
            hint: "keep its ids; you can give feedback on the next screen",
          },
          {
            id: "fresh",
            label: "Start this stage over",
            hint: "ignore the current version",
          },
          { id: "back", label: "Back", hint: "pick another stage" },
        ]}
        key="plan-regen-mode"
        onCancel={() => {
          setStep({ step: "regen-pick" });
        }}
        onSelect={(id) => {
          if (id === "back") {
            setStep({ step: "regen-pick" });
          } else {
            openStage(stage, {
              explore,
              revise: id === "existing" ? "existing" : "fresh",
              useExisting: false,
            });
          }
        }}
        title={`Regenerate ${PLAN_FILES[stage]}`}
      />
    );
  }

  if (step.step === "confirm-reset") {
    const open = snap.progress ? snap.progress.total - snap.progress.done : 0;

    return (
      <SelectList
        isActive={isActive}
        items={[
          { id: "keep", label: "Keep the current plan", hint: "go back" },
          {
            id: "reset",
            label: "Delete and start over",
            hint: `removes ${ctx.dirRel}/*.md — git keeps the history`,
          },
        ]}
        key="plan-confirm-reset"
        onCancel={() => {
          setStep({ step: "menu", notice: null });
        }}
        onSelect={(id) => {
          if (id !== "reset") {
            setStep({ step: "menu", notice: null });
            return;
          }

          void (async () => {
            await resetPlan(ctx);
            note([`Reset ${ctx.dirRel}`]);
            await refresh();
            openStage("requirements", {
              explore,
              revise: "fresh",
              useExisting: false,
            });
          })();
        }}
        title={
          open > 0
            ? `${open} task(s) are still open — an agent may be mid-build. Start over anyway?`
            : "Start a new plan for this branch?"
        }
      />
    );
  }

  if (step.step === "final") {
    return (
      <SelectList
        isActive={isActive}
        items={[
          {
            id: "copy",
            label: "Copy the loop prompt",
            hint: "paste it into Claude Code, Codex or any coding agent",
          },
          {
            id: "done",
            label: "Done",
            hint: `${ctx.dirRel}/${PLAN_FILES.loop} is on disk`,
          },
        ]}
        key="plan-final"
        onCancel={() => {
          finish({ status: "done", summary: summary() });
        }}
        onSelect={(id) => {
          void (async () => {
            if (id === "copy") {
              try {
                await copyToClipboard(await readLoopPrompt(ctx));
                note(["Copied the loop prompt to the clipboard."]);
              } catch (error) {
                note([
                  `Could not copy the loop prompt: ${getErrorMessage(error)}`,
                ]);
              }
            }

            finish({ status: "done", summary: summary() });
          })();
        }}
        title="Plan approved — hand it to your coding agent"
      />
    );
  }

  // step === "menu"
  const edited = PLAN_STAGES.filter(
    (stage) => snap.views[stage].editedSinceApproval,
  );
  const items = [
    ...(snap.unmanaged
      ? []
      : snap.next !== null
        ? [
            {
              id: "continue",
              label: `Continue: ${STAGE_TITLES[snap.next]} (${snap.views[snap.next].status})`,
              hint:
                snap.views[snap.next].status === "draft"
                  ? "review the saved draft"
                  : (snap.views[snap.next].staleBecause ?? "generate it"),
            },
          ]
        : []),
    ...(snap.progress !== null
      ? [
          {
            id: "sync",
            label: "Sync progress",
            hint: "match [T-n] commits and checkboxes; refresh the handoff status",
          },
        ]
      : []),
    ...(edited.length > 0
      ? [
          {
            id: "accept",
            label: `Accept hand edits (${edited.map((stage) => PLAN_FILES[stage]).join(", ")})`,
            hint: "re-approve the files as edited; later stages become stale",
          },
        ]
      : []),
    ...(snap.unmanaged
      ? []
      : [
          {
            id: "regen",
            label: "Regenerate a stage",
            hint: "revise with feedback or start a stage over",
          },
        ]),
    ...(snap.loopPromptExists
      ? [
          {
            id: "copy",
            label: "Copy loop prompt",
            hint: "for Claude Code, Codex or any coding agent",
          },
        ]
      : []),
    {
      id: "reset",
      label: "Start a new plan",
      hint: "delete this branch's plan files",
    },
    { id: "close", label: "Close", hint: "back to the main menu" },
  ];

  // The list windows itself to the viewport; the status lines above it only
  // render in the rows it leaves over, so a short terminal never overflows.
  const listRows =
    Math.min(items.length, Math.max(3, contentRows - 4)) + SELECT_LIST_CHROME;
  const spareRows = contentRows - listRows - (step.notice !== null ? 1 : 0);

  return (
    <Box flexDirection="column">
      {spareRows >= 2 ? (
        <Text color={theme.dim} wrap="truncate-end">
          {buildStepper(snap, null)}
        </Text>
      ) : null}
      {spareRows >= 1 ? (
        <Text color={theme.dim} wrap="truncate-end">
          {snap.unmanaged
            ? `${ctx.dirRel} has plan files but no readable index.md`
            : snap.progress
              ? summarizeProgress(snap.progress)
              : `${ctx.dirRel}/ · no tasks yet`}
        </Text>
      ) : null}
      {step.notice !== null ? (
        <Text color={theme.error} wrap="truncate-end">
          {step.notice.split("\n")[0]}
        </Text>
      ) : null}
      <SelectList
        isActive={isActive}
        items={items}
        key="plan-menu"
        onCancel={() => {
          finish({ status: "cancelled", summary: summary() });
        }}
        onSelect={(id) => {
          const next = snap.next;

          if (id === "continue" && next !== null) {
            openStage(next, { explore, revise: "fresh", useExisting: true });
          } else if (id === "sync") {
            void runAction(
              "Syncing progress...",
              () => syncPlan(ctx),
              "Progress synced",
            );
          } else if (id === "accept") {
            void runAction(
              "Re-approving edits...",
              async () => {
                const lines: string[] = [];

                for (const stage of edited) {
                  lines.push(...(await approveStage(ctx, stage)));
                }

                return lines;
              },
              "Hand edits accepted",
            );
          } else if (id === "regen") {
            setStep({ step: "regen-pick" });
          } else if (id === "copy") {
            void runAction(
              "Copying...",
              async () => {
                await copyToClipboard(await readLoopPrompt(ctx));

                return [
                  `Copied ${ctx.dirRel}/${PLAN_FILES.loop} to the clipboard.`,
                ];
              },
              "Loop prompt copied",
            );
          } else if (id === "reset") {
            setStep({ step: "confirm-reset" });
          } else {
            finish({ status: "done", summary: summary() });
          }
        }}
        title={`Spec plan — ${ctx.dirRel}`}
      />
    </Box>
  );
}

/** "Stage 2/4 · ✓ Requirements ▸ Design · Tasks · Handoff" */
export function buildStepper(
  snap: PlanSnapshot,
  current: PlanStageId | null,
): string {
  const parts = PLAN_STAGES.map((stage) => {
    const view = snap.views[stage];
    const mark =
      stage === current
        ? "▸"
        : view.status === "approved" && !view.editedSinceApproval
          ? "✓"
          : view.status === "stale"
            ? "!"
            : view.status === "draft"
              ? "~"
              : "·";

    return `${mark} ${STAGE_TITLES[stage]}`;
  });
  const position =
    current === null ? "" : `Stage ${PLAN_STAGES.indexOf(current) + 1}/4 · `;

  return `${position}${parts.join("  ")}`;
}

function generatingLabel(stage: PlanStageId, explore: boolean): string {
  const reading =
    explore && (stage === "requirements" || stage === "design")
      ? " (reading the repository first)"
      : "";

  return `Writing ${PLAN_FILES[stage]}${reading}...`;
}

const REFINE_PLACEHOLDERS: Record<PlanStageId, string> = {
  requirements:
    "e.g. Split REQ-2 into rate limiting and lockout; SSO is out of scope (multi-line ok)",
  design:
    "e.g. Reuse the existing queue module instead of a new worker; add a rollback risk (multi-line ok)",
  tasks:
    "e.g. Merge T-3 and T-4; put the migration first; Verify with pnpm test auth (multi-line ok)",
  handoff:
    "e.g. T-2 is blocked on the API key; note the open question about retries (multi-line ok)",
};
