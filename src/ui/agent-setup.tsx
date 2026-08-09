import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { GlobalFlags } from "../commands.js";
import {
  AGENT_DIR,
  findExistingAgentFiles,
  planAgentSetup,
  writeAgentSetup,
  type AgentPlan,
  type Answer,
  type PlannedAgent,
} from "../domain/agent-setup.js";
import {
  InlinePrompt,
  MultilinePrompt,
  MultiSelectList,
  SelectList,
} from "./menu-view.js";
import { useReviewLogRows } from "./review-shared.js";
import { appendEvent, RunLog, type LogItem } from "./run-view.js";
import { getErrorMessage, isDebugMode } from "./shared.js";
import { theme } from "./theme.js";

export type AgentSetupOutcome =
  | { status: "completed"; summary: string[] }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

/**
 * Rows this flow renders around a streamed run log: the phase heading, the
 * stack line, and a cushion. Passed to useReviewLogRows so the clamp tracks
 * terminal height (an over-tall frame makes Ink clear and repaint the whole
 * screen per chunk, which reads as a freeze).
 */
const RUN_EXTRA_ROWS = 6;

type Phase =
  | { phase: "analyzing" }
  | {
      phase: "questions";
      plan: AgentPlan;
      repoRoot: string;
      index: number;
      answers: Answer[];
    }
  | { phase: "roster"; plan: AgentPlan; repoRoot: string; answers: Answer[] }
  | {
      phase: "existing";
      plan: AgentPlan;
      repoRoot: string;
      answers: Answer[];
      roster: PlannedAgent[];
      existing: string[];
    }
  | { phase: "writing" }
  | { phase: "error"; message: string; retry: "analyze" | null }
  | { phase: "done"; summary: string[] };

type AgentSetupFlowProps = {
  flags: GlobalFlags;
  isActive: boolean;
  onDone: (outcome: AgentSetupOutcome) => void;
};

/**
 * Analyze → ask → generate flow for the project's agent roster.
 *
 * Two model passes with the interview between them, because the agent loop
 * cannot stop to ask a question mid-run: the first pass reports what it needs
 * to know, the UI collects it, the second pass writes the definitions.
 */
export function AgentSetupFlow({
  flags,
  isActive,
  onDone,
}: AgentSetupFlowProps) {
  const runRows = useReviewLogRows(RUN_EXTRA_ROWS);
  const [phase, setPhase] = useState<Phase>({ phase: "analyzing" });
  const [log, setLog] = useState<LogItem[]>([]);
  const cancelledRef = useRef(false);
  const startedRef = useRef(false);
  const doneRef = useRef(false);
  const nextLogId = useRef(1);

  function finish(outcome: AgentSetupOutcome): void {
    if (doneRef.current) {
      return;
    }

    doneRef.current = true;
    // Deferred a tick so the final frame renders before a host reacts with
    // app.exit() (same pattern as DocsReviewFlow).
    setTimeout(() => {
      onDone(outcome);
    }, 0);
  }

  function onEvent(event: Parameters<typeof appendEvent>[1]): void {
    setLog((current) => appendEvent(current, event, () => nextLogId.current++));
  }

  async function analyze(): Promise<void> {
    setLog([]);
    setPhase({ phase: "analyzing" });

    try {
      const { plan, repoRoot } = await planAgentSetup(flags, process.cwd(), {
        debug: isDebugMode(),
        onEvent,
      });

      if (cancelledRef.current) {
        return;
      }

      // Skip the interview when the analysis had nothing it needed to ask.
      setPhase(
        plan.questions.length > 0
          ? { phase: "questions", plan, repoRoot, index: 0, answers: [] }
          : { phase: "roster", plan, repoRoot, answers: [] },
      );
    } catch (error) {
      if (cancelledRef.current) {
        return;
      }

      setPhase({
        phase: "error",
        message: getErrorMessage(error),
        retry: "analyze",
      });
    }
  }

  /** Roster confirmed: check what already exists before deciding how to write. */
  async function afterRoster(
    plan: AgentPlan,
    repoRoot: string,
    answers: Answer[],
    roster: PlannedAgent[],
  ): Promise<void> {
    if (roster.length === 0) {
      finish({ status: "cancelled" });
      return;
    }

    const existing = await findExistingAgentFiles(
      repoRoot,
      roster.map((agent) => agent.id),
    );

    if (cancelledRef.current) {
      return;
    }

    if (existing.length === 0) {
      void generate(plan, answers, roster, [], 0);
      return;
    }

    setPhase({ phase: "existing", plan, repoRoot, answers, roster, existing });
  }

  /**
   * `roster` is already the writable set: anything the author chose to keep
   * has been removed, so the whitelist the prompt receives cannot name a file
   * we promised to leave alone. `refresh` are the ids inside it that exist and
   * must be edited rather than created (write_file errors on an existing path).
   */
  async function generate(
    plan: AgentPlan,
    answers: Answer[],
    roster: PlannedAgent[],
    refresh: string[],
    kept: number,
  ): Promise<void> {
    setLog([]);
    setPhase({ phase: "writing" });

    try {
      const text = await writeAgentSetup(
        { roster, refresh, answers, stack: plan.stack },
        flags,
        process.cwd(),
        { debug: isDebugMode(), onEvent },
      );

      if (cancelledRef.current) {
        return;
      }

      const created = roster.length - refresh.length;
      const summary = [
        `Created ${created} and refreshed ${refresh.length} definition(s) in ${AGENT_DIR}/`,
        ...(kept > 0 ? [`Kept ${kept} existing definition(s) untouched.`] : []),
        // The agent closes with one line per file; keep only that tail.
        ...text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .slice(-10),
      ];

      setPhase({ phase: "done", summary });
      finish({ status: "completed", summary });
    } catch (error) {
      if (cancelledRef.current) {
        return;
      }

      setPhase({
        phase: "error",
        message: getErrorMessage(error),
        retry: null,
      });
    }
  }

  useEffect(() => {
    if (startedRef.current) {
      return;
    }

    startedRef.current = true;
    void analyze();

    return () => {
      cancelledRef.current = true;
    };
    // Mount-only: the flow drives itself through phase transitions.
  }, []);

  if (phase.phase === "analyzing" || phase.phase === "writing") {
    return (
      <Box flexDirection="column">
        <Text color={theme.accent}>
          {phase.phase === "analyzing"
            ? "Analyzing the project..."
            : "Writing the agent definitions..."}
        </Text>
        {/* Bounded: the log grows by a row per streamed chunk, and a frame
            that reaches the terminal's height makes Ink clear and repaint the
            whole screen for every chunk after that. */}
        <RunLog log={log} maxRows={runRows} waiting />
      </Box>
    );
  }

  if (phase.phase === "error") {
    return (
      <Box flexDirection="column">
        <Text color={theme.error}>Error: {phase.message}</Text>
        <SelectList
          isActive={isActive}
          items={[
            ...(phase.retry === "analyze"
              ? [
                  {
                    id: "retry",
                    label: "Retry",
                    hint: "analyze the project again",
                  },
                ]
              : []),
            { id: "cancel", label: "Cancel", hint: "go back to the menu" },
          ]}
          key="error"
          onCancel={() => {
            finish({ status: "failed", message: phase.message });
          }}
          onSelect={(id) => {
            if (id === "retry") {
              void analyze();
            } else {
              finish({ status: "failed", message: phase.message });
            }
          }}
          title="The request failed"
        />
      </Box>
    );
  }

  if (phase.phase === "questions") {
    // Bound to a const: a hoisted `function` declaration would be typed
    // against the whole Phase union, not this narrowed branch.
    const asking = phase;
    const question = asking.plan.questions[asking.index];
    const step = `(${asking.index + 1}/${asking.plan.questions.length}, optional)`;
    const label = `${question.question} ${step}`;
    const answer = (value: string): void => {
      // An empty answer is a skip, not an empty fact to hand the model.
      const answers =
        value.length > 0
          ? [...asking.answers, { question: question.question, answer: value }]
          : asking.answers;

      if (asking.index + 1 < asking.plan.questions.length) {
        setPhase({ ...asking, index: asking.index + 1, answers });
        return;
      }

      setPhase({
        phase: "roster",
        plan: asking.plan,
        repoRoot: asking.repoRoot,
        answers,
      });
    };

    return (
      <Box flexDirection="column">
        {question.why.length > 0 ? (
          <Text color={theme.dim}>{question.why}</Text>
        ) : null}
        {question.multiline ? (
          <MultilinePrompt
            allowEmpty
            isActive={isActive}
            key={question.id}
            label={label}
            onCancel={() => {
              finish({ status: "cancelled" });
            }}
            onSubmit={answer}
            placeholder="answer in your own words — empty to skip"
          />
        ) : (
          <InlinePrompt
            allowEmpty
            isActive={isActive}
            key={question.id}
            label={label}
            onCancel={() => {
              finish({ status: "cancelled" });
            }}
            onSubmit={answer}
            placeholder="empty to skip"
          />
        )}
      </Box>
    );
  }

  if (phase.phase === "roster") {
    return (
      <Box flexDirection="column">
        {phase.plan.stack.length > 0 ? (
          <Text color={theme.dim} wrap="truncate-end">
            Detected: {phase.plan.stack.join(", ")}
          </Text>
        ) : null}
        <MultiSelectList
          isActive={isActive}
          items={phase.plan.roster.map((agent) => ({
            id: agent.id,
            label: agent.label,
            hint: agent.role,
          }))}
          key="roster"
          onCancel={() => {
            finish({ status: "cancelled" });
          }}
          onConfirm={(ids) => {
            void afterRoster(
              phase.plan,
              phase.repoRoot,
              phase.answers,
              phase.plan.roster.filter((agent) => ids.includes(agent.id)),
            );
          }}
          title={`Agents to create in ${AGENT_DIR}/ — deselect any you don't want`}
        />
      </Box>
    );
  }

  if (phase.phase === "existing") {
    return (
      <SelectList
        isActive={isActive}
        items={[
          {
            id: "refresh",
            label: "Refresh them",
            hint: "update the existing definitions, preserving hand-written parts",
          },
          {
            id: "keep",
            label: "Keep them",
            hint: "leave them untouched and only write the new ones",
          },
        ]}
        key="existing"
        onCancel={() => {
          finish({ status: "cancelled" });
        }}
        onSelect={(choice) => {
          // "Keep" removes those agents from the roster outright, so the write
          // pass is never even told the paths exist.
          const roster =
            choice === "refresh"
              ? phase.roster
              : phase.roster.filter(
                  (agent) => !phase.existing.includes(agent.id),
                );

          void generate(
            phase.plan,
            phase.answers,
            roster,
            choice === "refresh" ? phase.existing : [],
            choice === "refresh" ? 0 : phase.existing.length,
          );
        }}
        title={`${phase.existing.length} definition(s) already exist: ${phase.existing.join(", ")}`}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.accent}>Project agents</Text>
      {phase.summary.map((line, index) => (
        <Text color={theme.ok} key={index} wrap="truncate-end">
          ✓ {line}
        </Text>
      ))}
    </Box>
  );
}
