/**
 * Agent configuration service (owner console).
 *
 * The public surface other packages depend on:
 *   - `getCurrentConfigVersion(teamId)` — the runtime's prompt-assembly input.
 *   - `applyPendingConfigVersions(leagueId)` — the scheduler's unlock hook.
 * Everything else backs the console UI.
 *
 * Read models are deliberately viewer-free: configs, versions and diffs are
 * public within the league (PRD 5.5 / 7). Only the write paths check identity.
 */
export {
  ConfigForbiddenError,
  ConfigNotFoundError,
  ConfigValidationError,
  type ConfigIssue,
} from "./errors";

export {
  DEFAULT_HARNESS_SETTINGS,
  MAX_STEPS_CEILING,
  MAX_STEPS_FLOOR,
  REASONING_EFFORTS,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  TOKEN_BUDGET_MAX,
  TOKEN_BUDGET_MIN,
  harnessInputSchema,
  modelSupportsReasoning,
  parseHarness,
  type HarnessSettings,
} from "./harness";

export {
  editLockStatusFor,
  ensureAgentConfig,
  getConfigForTeam,
  getCurrentConfigVersion,
  getEditLockStatus,
  getPreviousVersion,
  getVersion,
  getVersionContext,
  listPendingConfigs,
  listVersions,
  toEditLock,
  type ConfigVersionSummary,
  type ConfigVersionWithSkills,
  type EditLockStatus,
  type TeamConfigView,
} from "./queries";

export {
  diffContext,
  diffHarness,
  diffSkills,
  diffVersionRows,
  diffVersions,
  type ConfigDiff,
  type ContextDiff,
  type DiffHunk,
  type DiffLine,
  type FieldDiff,
  type SkillDiff,
  type VersionStamp,
} from "./diff";

export {
  ASSUMED_OUTPUT_TOKENS_PER_STEP,
  ASSUMED_STEPS,
  BASE_PROMPT_TOKENS,
  CHARS_PER_TOKEN,
  estimatePromptSize,
  estimateTokens,
  type EstimateInput,
  type PromptEstimate,
} from "./estimate";

export {
  MAX_ATTACHED_SKILLS,
  applyPendingConfigVersions,
  assertMayEdit,
  canEditConfig,
  saveVersion,
  setNoteToAgent,
  validateAgainstRules,
  type SaveVersionInput,
  type SaveVersionResult,
} from "./save";
