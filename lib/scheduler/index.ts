/**
 * Scheduler barrel: window templates, materialization, the tick, and the draft
 * state machine. `app/api/cron/tick` is a thin wrapper over `runTick`.
 */
export * from "./templates";
export * from "./materialize";
export * from "./runs";
export * from "./tick";
export { progressDraft, draftProgress, type DraftProgressReport } from "./draft-progression";
export {
  localOptimalLineup,
  localCommitLineup,
  safeApplySafetyAutopilot,
  safeCommitLineup,
  safeComputeOptimalLineup,
  eligiblePositions,
  isStarter,
  slotsFromShape,
} from "./lineup-fallback";
