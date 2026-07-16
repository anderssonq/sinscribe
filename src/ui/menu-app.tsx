import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  getHelpText,
  type CommandSpec,
  type GlobalFlags,
} from "../commands.js";
import {
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderAuthKind,
  getProviderCommand,
  getProviderLabel,
  getProviderModelOptions,
  isValidModelId,
  isValidProvider,
  resolveConfiguredProvider,
  SELECTABLE_PROVIDERS,
  SINSCRIBE_MODEL_ID_ENV_KEY,
  SINSCRIBE_THEME_ENV_KEY,
  type SinscribeProvider,
} from "../constants.js";
import { InitSetup, needsCredentialSetup } from "../credentials.js";
import {
  generateBranchSuggestions,
  type BranchSuggestions,
} from "../domain/branch.js";
import {
  applyBranchName,
  type BranchActionMode,
} from "../domain/branch-actions.js";
import { createCredentialPreview, saveSinscribeEnv } from "../env.js";
import { testProviderConnection } from "../llm/healthcheck.js";
import { resolveProviderApiKey } from "../llm/model.js";
import { getRangeShortStat, getWorktreeShortStat } from "../git/diff.js";
import { getCurrentBranch, getRepoRoot, resolveBaseRef } from "../git/repo.js";
import {
  deleteSession,
  getSessionPath,
  loadSession,
  saveSession,
  type BranchSession,
} from "../session/store.js";
import { renderTemplatePreview } from "../templates/render.js";
import { loadTemplates, type TemplateEntry } from "../templates/registry.js";
import { DocsReviewFlow } from "./docs-review.js";
import { HelpView } from "./help-view.js";
import { Logo } from "./logo.js";
import { Panel } from "./panel.js";
import { useViewport } from "./viewport.js";
import {
  buildMenuItems,
  isOnWorkBranch,
  type MenuChoice,
} from "./menu-items.js";
import { MouseProvider } from "./mouse.js";
import {
  InlinePrompt,
  MainMenu,
  MultilinePrompt,
  PreviewPane,
  SelectList,
} from "./menu-view.js";
import { PrReviewFlow } from "./pr-review.js";
import { PromptReviewFlow } from "./prompt-review.js";
import {
  appendEvent,
  Header,
  RunLog,
  type HeaderStats,
  type LogItem,
} from "./run-view.js";
import { getErrorMessage, isDebugMode } from "./shared.js";
import { Spinner } from "./spinner.js";
import { setTerminalBackground, supportsBackgroundControl } from "./term.js";
import { getActiveThemeId, getThemeChoices, setTheme, theme } from "./theme.js";

type SessionDraft = {
  feature: string;
  ticket: string | null;
  requirements: string | null;
  baseRef: string | null;
};

type SettingsDraft = {
  provider: SinscribeProvider;
  modelId: string;
};

type MenuView =
  | { view: "menu" }
  | { view: "branch-input"; action: BranchActionMode }
  | {
      view: "branch-pick";
      suggestions: BranchSuggestions;
      action: BranchActionMode;
      baseRef: string | null;
    }
  | {
      view: "session-input";
      step: "feature" | "ticket" | "requirements" | "base";
      draft: SessionDraft;
      next: "menu" | "pr" | "branch" | "prompt";
    }
  | { view: "session-review" }
  | { view: "clear-confirm" }
  | { view: "template-pick"; templates: TemplateEntry[]; updating: boolean }
  | { view: "theme-pick"; previous: string }
  | { view: "docs-run" }
  | {
      view: "settings";
      step: "provider" | "model" | "key";
      draft: SettingsDraft;
    }
  | {
      view: "settings-test";
      draft: SettingsDraft;
      /** What the user typed at the key step ("" = keep the saved key). */
      apiKeyInput: string;
      phase:
        | { kind: "offer" }
        | { kind: "running" }
        | { kind: "failed"; message: string };
    }
  | { view: "help" }
  | { view: "running"; label: string; stream: boolean }
  | {
      view: "pr-review";
      label: string;
      spec: Extract<CommandSpec, { name: "pr" }>;
    }
  | {
      view: "prompt-review";
      label: string;
      spec: Extract<CommandSpec, { name: "prompt" }>;
    }
  | {
      view: "result";
      label: string;
      result: string | null;
      error: string | null;
    };

const EMPTY_DRAFT: SessionDraft = {
  feature: "",
  ticket: null,
  requirements: null,
  baseRef: null,
};

/**
/** What the provider list shows for providers that need no API key. */
function providerHint(provider: SinscribeProvider): string {
  const localCli = getProviderCommand(provider);

  return localCli === null ? "no API key" : `via the ${localCli.command} CLI`;
}

/**
 * After the model pick: api-key providers enter a key; local-cli providers
 * have nothing to collect at all — the child CLI owns its own credentials,
 * so the draft is persisted straight away.
 */
function nextSettingsStep(provider: SinscribeProvider): "key" | null {
  return getProviderAuthKind(provider) === "local-cli" ? null : "key";
}

/** Menu runs always start the prompt flow with its own type/describe steps. */
const EMPTY_PROMPT_SPEC: Extract<CommandSpec, { name: "prompt" }> = {
  name: "prompt",
  type: null,
  description: null,
  out: null,
};

const EMPTY_STATS: HeaderStats = { worktree: null, range: null };

/** How often the menu re-reads the git change stats while it sits on screen. */
const GIT_STATS_REFRESH_MS = 2000;

/** Menu-driven session (bare `sinscribe`): pick an action instead of typing. */
export function MenuApp({
  flags,
  onResult,
}: {
  flags: GlobalFlags;
  /**
   * Reports each successful result so the CLI can re-print the last one on
   * the normal screen buffer after the alt-screen menu exits.
   */
  onResult?: (text: string) => void;
}) {
  const app = useApp();
  const [mode, setMode] = useState<MenuView>({ view: "menu" });
  const [log, setLog] = useState<LogItem[]>([]);
  const [setupDone, setSetupDone] = useState(
    !needsCredentialSetup(flags.provider, flags.apiKey),
  );
  const [fatal, setFatal] = useState<string | null>(null);
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [session, setSession] = useState<BranchSession | null>(null);
  const [stats, setStats] = useState<HeaderStats>(EMPTY_STATS);
  const [detectedBase, setDetectedBase] = useState<string | null>(null);
  // Name of the template highlighted in the picker, driving its live preview.
  // Null until the cursor first moves; the render falls back to the initial id.
  const [previewName, setPreviewName] = useState<string | null>(null);
  // Bumped to repaint the tree when the active palette is mutated in place
  // (theme preview) — setTheme() alone does not trigger a React render.
  const [, forceThemeRepaint] = useState(0);
  const { columns, contentRows } = useViewport();
  const nextLogId = useRef(1);

  /** Builds the initial context form draft from the saved session, defaulting
   * the target branch to the auto-detected base when none was stored yet. */
  function initialDraft(): SessionDraft {
    const context = session?.context;

    return {
      feature: context?.feature ?? EMPTY_DRAFT.feature,
      ticket: context?.ticket ?? EMPTY_DRAFT.ticket,
      requirements: context?.requirements ?? EMPTY_DRAFT.requirements,
      baseRef: context?.baseRef ?? detectedBase,
    };
  }

  async function refreshSession(): Promise<{
    root: string | null;
    branch: string | null;
    session: BranchSession | null;
    detectedBase: string | null;
  }> {
    const cwd = process.cwd();
    const root = await getRepoRoot(cwd);
    const currentBranch = root ? await getCurrentBranch(cwd) : null;
    const [loaded, worktree, baseRef] = await Promise.all([
      root && currentBranch ? loadSession(root, currentBranch) : null,
      root ? getWorktreeShortStat(cwd) : null,
      root ? resolveBaseRef(cwd, null) : null,
    ]);
    const range = baseRef ? await getRangeShortStat(cwd, baseRef) : null;

    setRepoRoot(root);
    setBranch(currentBranch);
    setSession(loaded);
    setStats({ worktree, range });
    setDetectedBase(baseRef);

    return {
      root,
      branch: currentBranch,
      session: loaded,
      detectedBase: baseRef,
    };
  }

  /**
   * Re-reads only the git change stats (worktree + range). Cheap enough to
   * poll while the menu is on screen so the header's git figures track edits
   * and commits live, instead of freezing at the values captured on startup.
   */
  async function refreshStats(): Promise<void> {
    const cwd = process.cwd();
    const root = await getRepoRoot(cwd);

    if (root === null) {
      setStats(EMPTY_STATS);
      return;
    }

    const [worktree, baseRef] = await Promise.all([
      getWorktreeShortStat(cwd),
      resolveBaseRef(cwd, null),
    ]);
    const range = baseRef ? await getRangeShortStat(cwd, baseRef) : null;

    setStats({ worktree, range });
  }

  useEffect(() => {
    if (setupDone) {
      // Context-first: when the current branch has no saved context yet, open
      // the context form directly — pr/branch need it (built from the snapshot
      // returned by refreshSession, not from state that hasn't propagated yet).
      refreshSession()
        .then((snapshot) => {
          if (
            snapshot.root !== null &&
            snapshot.branch !== null &&
            snapshot.session?.context == null
          ) {
            setMode({
              view: "session-input",
              step: "feature",
              draft: { ...EMPTY_DRAFT, baseRef: snapshot.detectedBase },
              next: "menu",
            });
          }
        })
        .catch((error: unknown) => {
          showError("Session", getErrorMessage(error));
        });
    }
    // Refresh once after setup; goToMenu() handles later refreshes.
  }, [setupDone]);

  // Keep the header's git figures live: file edits and commits change the
  // numbers while the menu sits open, so re-read the git stats on an interval
  // instead of only at startup. Scoped to the menu view so forms, LLM runs,
  // and result screens aren't disturbed; the timer is torn down when we leave
  // the menu (the header only shows the figures on the menu view, so a stale
  // reading is never displayed).
  useEffect(() => {
    if (!setupDone || mode.view !== "menu") {
      return;
    }

    const interval = setInterval(() => {
      // A failed background stats poll must never crash the menu (an
      // unhandled rejection would trip the global process guard).
      refreshStats().catch(() => undefined);
    }, GIT_STATS_REFRESH_MS);

    return () => {
      clearInterval(interval);
    };
  }, [setupDone, mode.view]);

  function goToMenu() {
    void refreshSession();
    setMode({ view: "menu" });
  }

  /**
   * Switches the palette in place and repaints the terminal-window background
   * to match. The re-render that follows (goToMenu's setMode) repaints the
   * tree with the new colors, since every component reads `theme.*` live.
   */
  /**
   * Applies a palette live (preview): mutates the active theme, repaints the
   * terminal-window background, and forces a re-render so the whole tree
   * (logo, header, list) shows the new colors. Does not persist.
   */
  function previewTheme(id: string): void {
    if (!setTheme(id)) {
      return;
    }

    if (supportsBackgroundControl()) {
      setTerminalBackground(theme.bg);
    }

    forceThemeRepaint((tick) => tick + 1);
  }

  /**
   * Confirms a theme: applies it and persists it for the next launch (a failed
   * write must never interrupt the session).
   */
  function applyTheme(id: string): void {
    previewTheme(id);
    void saveSinscribeEnv({ [SINSCRIBE_THEME_ENV_KEY]: id }).catch(() => {});
  }

  function showError(label: string, message: string) {
    setMode({ view: "result", label, result: null, error: message });
  }

  /** Guards shared by the session and pr menu options. */
  function ensureBranch(label: string): boolean {
    if (repoRoot === null) {
      showError(label, "Not inside a git repository.");
      return false;
    }

    if (branch === null) {
      showError(label, "Detached HEAD — check out a branch first.");
      return false;
    }

    return true;
  }

  /**
   * Guards pr/branch: repo + branch + saved session context. Without a
   * context it redirects to the form, which continues to `next` on save.
   */
  function requireContext(
    label: string,
    next: "pr" | "branch" | "prompt",
  ): boolean {
    if (!ensureBranch(label)) {
      return false;
    }

    if (session?.context) {
      return true;
    }

    setMode({
      view: "session-input",
      step: "feature",
      draft: initialDraft(),
      next,
    });

    return false;
  }

  /** Opens the branch-name input; the action depends on where we stand. */
  function startBranchInput(current: BranchSession | null) {
    const base = current?.context?.baseRef ?? detectedBase;
    const action: BranchActionMode = isOnWorkBranch(branch, base)
      ? "rename"
      : "create";

    setMode({ view: "branch-input", action });
  }

  function branchActionLabel(action: BranchActionMode): string {
    return action === "rename" ? "Rename branch" : "Create branch name";
  }

  /**
   * Generates structured suggestions and moves to the pick list. The ticket and
   * description come from the saved session context (guaranteed present here);
   * `preferences` is the user's free-text format guidance, not the subject.
   */
  async function generateAndPick(
    preferences: string,
    action: BranchActionMode,
  ): Promise<void> {
    const label = branchActionLabel(action);

    setLog([]);
    setMode({ view: "running", label, stream: false });

    try {
      const suggestions = await generateBranchSuggestions(
        { name: "branch", input: "", type: null },
        flags,
        {
          sessionContext: session?.context ?? null,
          preferences,
          callbacks: {
            debug: isDebugMode(),
            onEvent: (event) => {
              if (event.type !== "debug" && event.type !== "status") {
                return;
              }

              setLog((current) =>
                appendEvent(current, event, () => nextLogId.current++),
              );
            },
          },
        },
      );
      const names = suggestions.names.filter((name) => name !== branch);

      if (names.length === 0) {
        showError(
          label,
          "Every suggested name matches the current branch — try a different description.",
        );
        return;
      }

      setMode({
        view: "branch-pick",
        suggestions: { ...suggestions, names },
        action,
        baseRef: session?.context?.baseRef ?? detectedBase,
      });
    } catch (error) {
      showError(label, getErrorMessage(error));
    }
  }

  /** Runs the chosen git action (checkout -b / branch -m) and reports it. */
  async function applyPickedBranchName(
    name: string,
    action: BranchActionMode,
    baseRef: string | null,
  ): Promise<void> {
    const label = branchActionLabel(action);

    if (repoRoot === null) {
      showError(label, "Not inside a git repository.");
      return;
    }

    setLog([]);
    setMode({
      view: "running",
      label: action === "rename" ? "Renaming branch" : "Creating branch",
      stream: false,
    });

    try {
      const applied = await applyBranchName({
        cwd: process.cwd(),
        repoRoot,
        name,
        mode: action,
        baseRef,
        sourceSession: session,
      });

      await refreshSession();

      const result = [
        applied.mode === "create"
          ? `Created branch ${applied.branch} from ${applied.baseRef ?? "?"}`
          : `Renamed current branch to ${applied.branch}`,
        applied.sessionMigrated
          ? 'Session context migrated — "Create PR description" is ready here.'
          : null,
      ]
        .filter((line) => line !== null)
        .join("\n");

      onResult?.(result);
      setMode({ view: "result", label, result, error: null });
    } catch (error) {
      showError(label, getErrorMessage(error));
    }
  }

  /**
   * Wipes the branch's saved session (context + any generated PR) and drops
   * the user back into the context form to re-enter it from scratch. Cancelling
   * that form (esc) just returns to the menu with the session already cleared.
   */
  async function clearAndRestart(): Promise<void> {
    const label = "Clear session context";

    if (repoRoot === null || branch === null) {
      showError(label, "Not inside a git repository.");
      return;
    }

    try {
      await deleteSession(repoRoot, branch);
    } catch (error) {
      showError(label, getErrorMessage(error));
      return;
    }

    setSession(null);
    setMode({
      view: "session-input",
      step: "feature",
      // The session is gone, so seed an empty draft (initialDraft() would still
      // read the pre-clear session state on this render).
      draft: { ...EMPTY_DRAFT, baseRef: detectedBase },
      next: "menu",
    });
  }

  async function saveContextAndContinue(
    draft: SessionDraft,
    next: "menu" | "pr" | "branch" | "prompt",
  ): Promise<void> {
    if (repoRoot === null || branch === null) {
      return;
    }

    const now = new Date().toISOString();
    const updated: BranchSession = {
      version: 1,
      branch,
      context: {
        feature: draft.feature,
        ticket: draft.ticket,
        requirements: draft.requirements,
        baseRef: draft.baseRef,
      },
      pr: session?.pr ?? null,
      createdAt: session?.createdAt ?? now,
      updatedAt: now,
    };

    try {
      await saveSession(repoRoot, updated);
    } catch (error) {
      showError("Create session context", getErrorMessage(error));
      return;
    }

    setSession(updated);

    if (next === "menu") {
      const result = `Session context saved for ${branch}\n(${getSessionPath(repoRoot, branch)})`;

      onResult?.(result);
      setMode({
        view: "result",
        label: "Create session context",
        result,
        error: null,
      });
    } else if (next === "pr") {
      await openTemplatePicker(updated);
    } else if (next === "prompt") {
      setMode({
        view: "prompt-review",
        label: "Create feature or bugfix prompt",
        spec: EMPTY_PROMPT_SPEC,
      });
    } else {
      startBranchInput(updated);
    }
  }

  async function openTemplatePicker(
    current: BranchSession | null,
  ): Promise<void> {
    const label = "Create PR description";

    try {
      const templates = (await loadTemplates(repoRoot)).filter(
        (template) => template.kind === "pr",
      );

      if (templates.length === 0) {
        showError(label, "No PR templates found. Run: sinscribe template list");
        return;
      }

      // Reset so the preview starts on the cursor's initial template, not a
      // stale highlight from a previous open of the picker.
      setPreviewName(null);
      setMode({
        view: "template-pick",
        templates,
        updating: current?.pr != null,
      });
    } catch (error) {
      showError(label, getErrorMessage(error));
    }
  }

  function handleSelect(choice: MenuChoice) {
    switch (choice) {
      case "session":
        if (ensureBranch("Create session context")) {
          setMode({
            view: "session-input",
            step: "feature",
            draft: initialDraft(),
            next: "menu",
          });
        }
        return;
      case "clear":
        // Guarded by the disabled state in buildMenuItems, but re-check so a
        // stray click can never open the confirm on a context-less branch.
        if (ensureBranch("Clear session context") && session?.context) {
          setMode({ view: "clear-confirm" });
        }
        return;
      case "pr":
        if (!requireContext("Create PR description", "pr")) {
          return;
        }

        setMode({ view: "session-review" });
        return;
      case "prompt":
        if (!requireContext("Create feature or bugfix prompt", "prompt")) {
          return;
        }

        setMode({
          view: "prompt-review",
          label: "Create feature or bugfix prompt",
          spec: EMPTY_PROMPT_SPEC,
        });
        return;
      case "branch":
        if (!requireContext("Create branch name", "branch")) {
          return;
        }

        startBranchInput(session);
        return;
      case "docs":
        if (repoRoot === null) {
          showError("Generate documentation", "Not inside a git repository.");
          return;
        }

        setLog([]);
        setMode({ view: "docs-run" });
        return;
      case "settings": {
        const provider = resolveConfiguredProvider();
        const modelId =
          process.env[SINSCRIBE_MODEL_ID_ENV_KEY]?.trim() ||
          getDefaultModelId(provider);

        setMode({
          view: "settings",
          step: "provider",
          draft: { provider, modelId },
        });
        return;
      }
      case "theme":
        setMode({ view: "theme-pick", previous: getActiveThemeId() });
        return;
      case "help":
        setMode({ view: "help" });
        return;
      case "exit":
        process.exitCode = 0;
        app.exit();
    }
  }

  /** Model step → whatever that provider still needs (possibly nothing). */
  function advanceAfterModel(draft: SettingsDraft): void {
    const step = nextSettingsStep(draft.provider);

    if (step === null) {
      void saveSettingsAndContinue(draft, "", [
        `Credentials are managed by the ${getProviderLabel(draft.provider)} binary itself.`,
      ]);
      return;
    }

    setMode({ view: "settings", step, draft });
  }

  async function saveSettingsAndContinue(
    draft: SettingsDraft,
    apiKeyInput: string,
    extraLines: string[] = [],
  ): Promise<void> {
    const apiKeyEnvKey = getProviderApiKeyEnvKey(draft.provider);
    const trimmed = apiKeyInput.trim();
    const updates: Record<string, string> = {
      SINSCRIBE_PROVIDER: draft.provider,
      SINSCRIBE_MODEL_ID: draft.modelId,
      ...(trimmed.length > 0 && apiKeyEnvKey !== null
        ? { [apiKeyEnvKey]: trimmed }
        : {}),
    };

    try {
      await saveSinscribeEnv(updates);
    } catch (error) {
      showError("AI settings", getErrorMessage(error));
      return;
    }

    const result = [
      `Provider: ${getProviderLabel(draft.provider)}`,
      `Model: ${draft.modelId}`,
      ...(apiKeyEnvKey !== null
        ? [
            trimmed.length > 0
              ? `API key: updated (${apiKeyEnvKey})`
              : `API key: unchanged (${apiKeyEnvKey})`,
          ]
        : []),
      ...extraLines,
    ].join("\n");

    onResult?.(result);
    setMode({ view: "result", label: "AI settings", result, error: null });
  }

  /** GET /models with the pending key; saves on success, offers retry on failure. */
  async function runConnectionTest(
    draft: SettingsDraft,
    apiKeyInput: string,
  ): Promise<void> {
    setMode({
      view: "settings-test",
      draft,
      apiKeyInput,
      phase: { kind: "running" },
    });

    let apiKey: string;

    try {
      apiKey = resolveProviderApiKey(draft.provider, apiKeyInput || null);
    } catch (error) {
      setMode({
        view: "settings-test",
        draft,
        apiKeyInput,
        phase: { kind: "failed", message: getErrorMessage(error) },
      });
      return;
    }

    const result = await testProviderConnection({
      provider: draft.provider,
      apiKey,
      modelId: draft.modelId,
    });

    if (result.ok) {
      const detail =
        result.modelCount !== null
          ? `Connection OK — ${result.modelCount} models listed${
              result.modelFound === true
                ? `, ${draft.modelId} available`
                : result.modelFound === false
                  ? `, but ${draft.modelId} is not in the list`
                  : ""
            }`
          : "Connection OK — this endpoint does not expose a model list";

      await saveSettingsAndContinue(draft, apiKeyInput, [detail]);
    } else {
      setMode({
        view: "settings-test",
        draft,
        apiKeyInput,
        phase: { kind: "failed", message: result.message },
      });
    }
  }

  // Any key returns to the menu from the result screen. (Help owns its own
  // input so it can scroll; esc/q there returns to the menu.)
  useInput(
    () => {
      goToMenu();
    },
    { isActive: setupDone && mode.view === "result" },
  );

  // Session review: enter → template picker, e → edit context, esc → menu.
  useInput(
    (value, key) => {
      if (key.return) {
        void openTemplatePicker(session);
        return;
      }

      if (value === "e") {
        setMode({
          view: "session-input",
          step: "feature",
          draft: initialDraft(),
          next: "pr",
        });
        return;
      }

      if (key.escape || value === "q") {
        goToMenu();
      }
    },
    { isActive: setupDone && mode.view === "session-review" },
  );

  if (fatal !== null) {
    return <Text color={theme.error}>Error: {fatal}</Text>;
  }

  if (!setupDone) {
    return (
      <InitSetup
        onComplete={() => {
          setSetupDone(true);
        }}
        onError={(message) => {
          setFatal(message);
          process.exitCode = 1;
          app.exit();
        }}
        overrideProvider={flags.provider}
      />
    );
  }

  const menuItems = buildMenuItems({
    session,
    branch,
    targetBase: session?.context?.baseRef ?? detectedBase,
  });

  return (
    <MouseProvider
      active={
        mode.view === "menu" ||
        mode.view === "clear-confirm" ||
        mode.view === "template-pick" ||
        mode.view === "theme-pick" ||
        mode.view === "branch-pick" ||
        mode.view === "pr-review" ||
        mode.view === "prompt-review" ||
        mode.view === "docs-run" ||
        mode.view === "help" ||
        (mode.view === "settings" && mode.step !== "key") ||
        (mode.view === "settings-test" && mode.phase.kind !== "running")
      }
    >
      <Box flexDirection="column">
        <Logo />
        <Header
          // Branch and stats only refresh while the menu is on screen — hide
          // them elsewhere so a frozen reading is never shown.
          branch={mode.view === "menu" ? branch : undefined}
          stats={mode.view === "menu" ? stats : undefined}
          subtitle={
            mode.view === "running"
              ? `${mode.label}...`
              : mode.view === "pr-review" || mode.view === "prompt-review"
                ? `${mode.label} — review before approving`
                : mode.view === "docs-run"
                  ? "Generate documentation — agent activity"
                  : mode.view === "help"
                    ? "Help — scroll with ↑/↓ or the wheel, esc to return"
                    : mode.view === "clear-confirm"
                      ? "Clear session context — this cannot be undone"
                      : // Menu view: no subtitle — the header lines carry it.
                        undefined
          }
        />
        {mode.view === "menu" ? (
          <MainMenu isActive items={menuItems} onSelect={handleSelect} />
        ) : null}
        {mode.view === "session-input" ? (
          <Box flexDirection="column">
            {mode.step === "feature" ? (
              <MultilinePrompt
                initialValue={mode.draft.feature}
                isActive
                key="feature"
                label="Feature — what are you building, and why? (1/4)"
                onCancel={goToMenu}
                onSubmit={(value) => {
                  setMode({
                    ...mode,
                    step: "ticket",
                    draft: { ...mode.draft, feature: value },
                  });
                }}
                placeholder="e.g. Add retry logic to the uploader so flaky networks don't drop files (multi-line ok)"
              />
            ) : null}
            {mode.step === "ticket" ? (
              <InlinePrompt
                allowEmpty
                initialValue={mode.draft.ticket ?? ""}
                isActive
                key="ticket"
                label="Ticket — Jira/business ticket ID (2/4, optional)"
                onCancel={goToMenu}
                onSubmit={(value) => {
                  setMode({
                    ...mode,
                    step: "requirements",
                    draft: { ...mode.draft, ticket: value || null },
                  });
                }}
                placeholder="e.g. ABC-123"
              />
            ) : null}
            {mode.step === "requirements" ? (
              <MultilinePrompt
                allowEmpty
                initialValue={mode.draft.requirements ?? ""}
                isActive
                key="requirements"
                label="Requirements & docs — acceptance criteria, business/technical rules, doc excerpts (3/4, optional)"
                onCancel={goToMenu}
                onSubmit={(value) => {
                  setMode({
                    ...mode,
                    step: "base",
                    draft: { ...mode.draft, requirements: value || null },
                  });
                }}
                placeholder="e.g. AC from the ticket; business/technical rules; paste key Confluence or design-doc excerpts (multi-line ok)"
              />
            ) : null}
            {mode.step === "base" ? (
              <InlinePrompt
                allowEmpty
                initialValue={mode.draft.baseRef ?? detectedBase ?? "main"}
                isActive
                key="base"
                label="Target branch — which branch will this merge into? (4/4)"
                onCancel={goToMenu}
                onSubmit={(value) => {
                  void saveContextAndContinue(
                    { ...mode.draft, baseRef: value.trim() || null },
                    mode.next,
                  );
                }}
                placeholder="e.g. main or develop"
              />
            ) : null}
          </Box>
        ) : null}
        {mode.view === "session-review" ? (
          <Box flexDirection="column">
            <Text color={theme.accent}>Session context for {branch}</Text>
            <Panel>
              <Text>
                <Text color={theme.dim}>Feature: </Text>
                {session?.context?.feature}
              </Text>
              <Text>
                <Text color={theme.dim}>Ticket: </Text>
                {session?.context?.ticket ?? "(none)"}
              </Text>
              <Text>
                <Text color={theme.dim}>Requirements &amp; docs: </Text>
                {session?.context?.requirements ?? "(none)"}
              </Text>
              <Text>
                <Text color={theme.dim}>Target branch: </Text>
                {session?.context?.baseRef ?? "(auto-detect)"}
              </Text>
              {session?.pr ? (
                <Text color={theme.dim}>
                  Last generated {session.pr.generatedAt} with template{" "}
                  {session.pr.template} — will be updated
                </Text>
              ) : null}
            </Panel>
            <Text color={theme.dim}>
              enter to continue — e to edit context — esc to go back
            </Text>
          </Box>
        ) : null}
        {mode.view === "clear-confirm" ? (
          <Box flexDirection="column">
            <Text color={theme.error}>
              This erases the saved context{session?.pr ? " and PR" : ""} for{" "}
              {branch}. You will re-enter it from scratch.
            </Text>
            <SelectList
              isActive
              items={[
                {
                  id: "clear",
                  label: "Clear and start over",
                  hint: "erase the saved context and re-enter it from the top",
                },
                {
                  id: "keep",
                  label: "Keep it",
                  hint: "cancel — nothing is removed",
                },
              ]}
              onCancel={goToMenu}
              onSelect={(id) => {
                if (id === "clear") {
                  void clearAndRestart();
                } else {
                  goToMenu();
                }
              }}
              title="Clear session context?"
            />
          </Box>
        ) : null}
        {mode.view === "template-pick"
          ? (() => {
              const initialId = session?.pr?.template ?? "andersoftware";
              // The template whose shape the preview shows: the highlighted one,
              // falling back to the cursor's initial id, then the first entry.
              const active =
                mode.templates.find((t) => t.name === previewName) ??
                mode.templates.find((t) => t.name === initialId) ??
                mode.templates[0];
              // Side-by-side only when there's room; otherwise stack the preview
              // under the list so a narrow terminal never squeezes it.
              const sideBySide = columns >= 100;

              const picker = (
                <SelectList
                  initialId={initialId}
                  isActive
                  items={mode.templates.map((template) => ({
                    id: template.name,
                    label: template.name,
                    hint: template.description || template.tier,
                  }))}
                  onCancel={goToMenu}
                  onHighlight={setPreviewName}
                  onSelect={(name) => {
                    setLog([]);
                    setMode({
                      view: "pr-review",
                      label: mode.updating
                        ? "Update PR description"
                        : "Create PR description",
                      spec: {
                        name: "pr",
                        template: name,
                        base: null,
                        ticket: null,
                        staged: false,
                        out: null,
                      },
                    });
                  }}
                  title={
                    mode.updating
                      ? "Updating existing PR description — pick a template"
                      : "Pick a PR template"
                  }
                />
              );

              const preview = active ? (
                <PreviewPane
                  grow={sideBySide}
                  text={renderTemplatePreview(active)}
                  title={`Preview: ${active.name}`}
                />
              ) : null;

              return sideBySide ? (
                <Box columnGap={2} flexDirection="row">
                  <Box flexShrink={0}>{picker}</Box>
                  {preview}
                </Box>
              ) : (
                <Box flexDirection="column">
                  {picker}
                  {preview}
                </Box>
              );
            })()
          : null}
        {mode.view === "theme-pick" ? (
          <SelectList
            initialId={getActiveThemeId()}
            isActive
            items={getThemeChoices()}
            onCancel={() => {
              // Revert the live preview to whatever was active before opening.
              previewTheme(mode.previous);
              goToMenu();
            }}
            onHighlight={previewTheme}
            onSelect={(id) => {
              applyTheme(id);
              goToMenu();
            }}
            title="Pick a color theme — live preview"
          />
        ) : null}
        {mode.view === "settings" ? (
          <Box flexDirection="column">
            {mode.step === "provider" ? (
              <SelectList
                initialId={mode.draft.provider}
                isActive
                items={SELECTABLE_PROVIDERS.map((provider) => ({
                  id: provider,
                  label: getProviderLabel(provider),
                  hint:
                    provider === mode.draft.provider
                      ? "current"
                      : (getProviderApiKeyEnvKey(provider) ??
                        providerHint(provider)),
                }))}
                onCancel={goToMenu}
                onSelect={(id) => {
                  const provider = isValidProvider(id)
                    ? id
                    : mode.draft.provider;
                  const modelId =
                    provider === mode.draft.provider
                      ? mode.draft.modelId
                      : getDefaultModelId(provider);

                  setMode({
                    view: "settings",
                    step: "model",
                    draft: { provider, modelId },
                  });
                }}
                title="Pick an AI provider"
              />
            ) : null}
            {mode.step === "model" ? (
              getProviderModelOptions(mode.draft.provider).length === 0 ? (
                <InlinePrompt
                  initialValue={mode.draft.modelId}
                  isActive
                  key={mode.draft.provider}
                  label={`Model ID for ${getProviderLabel(mode.draft.provider)}`}
                  onCancel={goToMenu}
                  onSubmit={(value) => {
                    if (!isValidModelId(value)) {
                      showError("AI settings", `Invalid model ID: ${value}`);
                      return;
                    }

                    advanceAfterModel({ ...mode.draft, modelId: value });
                  }}
                  placeholder="e.g. my-custom-model-id"
                />
              ) : (
                <SelectList
                  initialId={mode.draft.modelId}
                  isActive
                  items={getProviderModelOptions(mode.draft.provider).map(
                    (option) => ({
                      id: option.id,
                      label: option.label,
                      hint: option.id,
                    }),
                  )}
                  onCancel={goToMenu}
                  onSelect={(modelId) => {
                    advanceAfterModel({ ...mode.draft, modelId });
                  }}
                  title={`Pick a model for ${getProviderLabel(mode.draft.provider)}`}
                />
              )
            ) : null}
            {mode.step === "key" ? (
              <InlinePrompt
                allowEmpty
                isActive
                key={mode.draft.provider}
                label={`API key for ${getProviderLabel(mode.draft.provider)} (${getProviderApiKeyEnvKey(mode.draft.provider) ?? "API key"})`}
                mask
                onCancel={goToMenu}
                onSubmit={(value) => {
                  setMode({
                    view: "settings-test",
                    draft: mode.draft,
                    apiKeyInput: value,
                    phase: { kind: "offer" },
                  });
                }}
                placeholder={(() => {
                  const keyEnvKey = getProviderApiKeyEnvKey(
                    mode.draft.provider,
                  );
                  const current =
                    keyEnvKey === null ? undefined : process.env[keyEnvKey];

                  return current
                    ? `current: ${createCredentialPreview(current)} — leave empty to keep`
                    : "Paste your API key, enter to save, esc to cancel";
                })()}
              />
            ) : null}
          </Box>
        ) : null}
        {mode.view === "settings-test" ? (
          <Box flexDirection="column">
            {mode.phase.kind === "running" ? (
              <Spinner label="Testing connection..." />
            ) : null}
            {mode.phase.kind === "offer" ? (
              <SelectList
                isActive
                items={[
                  {
                    id: "test",
                    label: "Test connection",
                    hint: `GET /models against ${getProviderLabel(mode.draft.provider)} with this key`,
                  },
                  {
                    id: "save",
                    label: "Save without testing",
                    hint: "skip the connectivity check",
                  },
                ]}
                onCancel={() => {
                  setMode({
                    view: "settings",
                    step: "key",
                    draft: mode.draft,
                  });
                }}
                onSelect={(id) => {
                  if (id === "test") {
                    void runConnectionTest(mode.draft, mode.apiKeyInput);
                  } else {
                    void saveSettingsAndContinue(mode.draft, mode.apiKeyInput);
                  }
                }}
                title="Verify the API key before saving?"
              />
            ) : null}
            {mode.phase.kind === "failed" ? (
              <Box flexDirection="column">
                <Text color={theme.error} wrap="wrap">
                  Connection test failed: {mode.phase.message}
                </Text>
                <SelectList
                  isActive
                  items={[
                    {
                      id: "retry",
                      label: "Retry test",
                      hint: "run the connection test again",
                    },
                    {
                      id: "save",
                      label: "Save anyway",
                      hint: "persist these settings without a passing test",
                    },
                    {
                      id: "edit",
                      label: "Edit key",
                      hint: "go back and re-enter the API key",
                    },
                  ]}
                  onCancel={goToMenu}
                  onSelect={(id) => {
                    if (id === "retry") {
                      void runConnectionTest(mode.draft, mode.apiKeyInput);
                    } else if (id === "save") {
                      void saveSettingsAndContinue(
                        mode.draft,
                        mode.apiKeyInput,
                      );
                    } else {
                      setMode({
                        view: "settings",
                        step: "key",
                        draft: mode.draft,
                      });
                    }
                  }}
                  title="Connection failed — what next?"
                />
              </Box>
            ) : null}
          </Box>
        ) : null}
        {mode.view === "branch-input" ? (
          <InlinePrompt
            allowEmpty
            isActive
            label={`${branchActionLabel(mode.action)} — what format or preferences would you like? (optional)`}
            onCancel={goToMenu}
            onSubmit={(value) => {
              void generateAndPick(value, mode.action);
            }}
            placeholder="e.g. feature/[ticket]-[short-description] — ticket & description come from your context; empty for the default"
          />
        ) : null}
        {mode.view === "branch-pick" ? (
          <Box flexDirection="column">
            <SelectList
              isActive
              items={mode.suggestions.names.map((name) => ({
                id: name,
                label: name,
                hint:
                  mode.action === "create"
                    ? `git checkout -b — from ${mode.baseRef ?? "(unresolved base)"}`
                    : "git branch -m (rename the current branch)",
              }))}
              onCancel={goToMenu}
              onSelect={(name) => {
                void applyPickedBranchName(name, mode.action, mode.baseRef);
              }}
              title={
                mode.action === "rename"
                  ? "Pick the new name for the current branch"
                  : "Pick a branch name"
              }
            />
            {mode.action === "create" && stats.worktree ? (
              <Text color={theme.dim}>
                uncommitted changes will carry over — the checkout may fail if
                they conflict with the base
              </Text>
            ) : null}
          </Box>
        ) : null}
        {mode.view === "help" ? (
          <HelpView onExit={goToMenu} text={getHelpText()} />
        ) : null}
        {mode.view === "running" ? (
          <Box flexDirection="column">
            {mode.stream || log.length > 0 ? (
              // Bounded: an unwindowed stream grows past the alt-screen
              // viewport and leaves redraw residue on the next view.
              <RunLog log={log} maxRows={contentRows - 2} waiting />
            ) : (
              <Spinner label={`${mode.label}...`} />
            )}
          </Box>
        ) : null}
        {mode.view === "docs-run" ? (
          <DocsReviewFlow
            flags={flags}
            isActive
            onDone={(outcome) => {
              if (outcome.status === "completed") {
                const text = [outcome.content, "", ...outcome.summary]
                  .join("\n")
                  .trimEnd();

                onResult?.(text);
                setMode({
                  view: "result",
                  label: "Generate documentation",
                  result: text,
                  error: null,
                });
              } else if (outcome.status === "cancelled") {
                goToMenu();
              } else {
                showError("Generate documentation", outcome.message);
              }
            }}
          />
        ) : null}
        {mode.view === "pr-review" ? (
          <PrReviewFlow
            flags={flags}
            isActive
            onDone={(outcome) => {
              if (outcome.status === "approved") {
                const text = [outcome.description, "", ...outcome.summary]
                  .join("\n")
                  .trimEnd();

                onResult?.(text);
                setMode({
                  view: "result",
                  label: mode.label,
                  result: text,
                  error: null,
                });
              } else if (outcome.status === "cancelled") {
                goToMenu();
              } else {
                showError(mode.label, outcome.message);
              }
            }}
            spec={mode.spec}
          />
        ) : null}
        {mode.view === "prompt-review" ? (
          <PromptReviewFlow
            flags={flags}
            isActive
            onDone={(outcome) => {
              if (outcome.status === "approved") {
                const text = [outcome.content, "", ...outcome.summary]
                  .join("\n")
                  .trimEnd();

                onResult?.(text);
                setMode({
                  view: "result",
                  label: mode.label,
                  result: text,
                  error: null,
                });
              } else if (outcome.status === "cancelled") {
                goToMenu();
              } else {
                showError(mode.label, outcome.message);
              }
            }}
            spec={mode.spec}
          />
        ) : null}
        {mode.view === "result" ? (
          <Box flexDirection="column">
            {log.length > 0 ? (
              <RunLog log={log} maxRows={contentRows - 2} />
            ) : null}
            {mode.result !== null ? (
              <Box flexDirection="column" marginBottom={1}>
                <Text wrap="wrap">{mode.result}</Text>
              </Box>
            ) : null}
            {mode.error !== null ? (
              <Text color={theme.error}>Error: {mode.error}</Text>
            ) : null}
            <Text color={theme.dim}>press any key to return to the menu</Text>
          </Box>
        ) : null}
      </Box>
    </MouseProvider>
  );
}
