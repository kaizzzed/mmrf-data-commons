// ORION run-event contract v1 (orion/contracts/README.md in the sandbox repo).
// Hand-written: no AG-UI package is in the lockfile.

export const RUN_STATUSES = [
  'Planning',
  'Clarifying',
  'AwaitingConsent',
  'Executing',
  'AwaitingConfirmation',
  'Stopping',
  'Answering',
  'Complete',
  'Partial',
  'Limited',
  'Unsupported',
  'ObservedOnly',
  'Cancelled',
  'Failed',
  'Interrupted',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_STATUSES = [
  'Queued',
  'AwaitingUser',
  'Running',
  'Retrying',
  'Done',
  'Empty',
  'Failed',
  'Skipped',
  'Reused',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** Statuses a run pauses in; the next turn resumes it. */
export const WAITING_STATUSES = [
  'Clarifying',
  'AwaitingConsent',
  'AwaitingConfirmation',
] as const satisfies readonly RunStatus[];
export type WaitingStatus = (typeof WAITING_STATUSES)[number];

export const END_STATUSES = [
  'Complete',
  'Partial',
  'Limited',
  'Unsupported',
  'ObservedOnly',
  'Cancelled',
  'Failed',
  'Interrupted',
] as const satisfies readonly RunStatus[];
export type EndStatus = (typeof END_STATUSES)[number];

/**
 * RUN_FINISHED never carries Failed (RUN_ERROR does). It carries Interrupted only when the
 * turn targeted a run whose lease expired.
 */
export type FinishedStatus = WaitingStatus | Exclude<EndStatus, 'Failed'>;

export const LIMITATION_CODES = [
  'NAMED_TOOL_MISMATCH',
  'OUT_OF_PANEL',
  'INELIGIBLE_GROUP',
  'TOOL_FAILED',
  'MODEL_DECLINED',
  'PLANNER_DECLINED',
  'UNSUPPORTED_ANALYSIS',
  'CLINICAL_ADVICE',
  'OUT_OF_SCOPE',
  'EMPTY_COHORT',
  'WRITE_SKIPPED',
  'RUN_INTERRUPTED',
  'WRITE_VERIFY_FAILED',
  'VIEWER_P_ROUNDED',
  'UNSUPPORTED_FIELD',
  'UNKNOWN_FIELD',
  'UNKNOWN_VALUE',
] as const;
export type LimitationCode = (typeof LIMITATION_CODES)[number];

export const CONTROLLER_CODES = [
  'INVALID_INPUT',
  'NOT_IMPLEMENTED',
  'RUN_BUSY',
  'RUN_NOT_FOUND',
  'INTERNAL_ERROR',
] as const;
export type ControllerCode = (typeof CONTROLLER_CODES)[number];

/** RUN_ERROR codes that reject a turn: no run is created and no run's status changes. */
export const REJECTION_CODES = [
  'INVALID_INPUT',
  'RUN_BUSY',
  'RUN_NOT_FOUND',
  'NOT_IMPLEMENTED',
] as const satisfies readonly ControllerCode[];
export type RejectionCode = (typeof REJECTION_CODES)[number];

export type OrionCode = LimitationCode | ControllerCode;

// ---------------------------------------------------------------- RunView

export type ScopeSource =
  | 'all_cases'
  | 'active_cohort'
  | 'saved_cohort'
  | 'thread_cohort';

export interface PlanScope {
  source: ScopeSource;
  name: string;
  /** Null until a count is known: the browser sent none and no step has sized the scope yet. */
  caseCount: number | null;
}

export interface PlanRow {
  row: number;
  label: string;
  tool: string;
  reason: string;
  stepIds: string[];
}

export interface Assumption {
  code: string;
  text: string;
}

export interface Plan {
  version: number;
  signature: string;
  scope: PlanScope;
  rows: PlanRow[];
  assumptions: Assumption[];
  writes: boolean;
  paraphrase: string;
}

export type StepKind = 'server' | 'exec' | 'client';

export interface Step {
  id: string;
  row: number;
  tool: string;
  kind: StepKind;
  status: StepStatus;
  folded: boolean;
  inputSummary: string;
  outputSummary: string | null;
  durationMs: number | null;
  code: OrionCode | null;
}

export interface Fact {
  id: string;
  label: string;
  value: number;
  unit: string;
  stepId: string;
  row: number;
  tool: string;
  jsonPointer: string;
}

/** A segment with `factId` is a number that renders with its citation chip. */
export interface Segment {
  text: string;
  factId?: string;
}

export interface Sentence {
  segments: Segment[];
}

/** A catalog app that can take the question further, as the catalog names it. */
export interface NearestApp {
  appId: string;
  title: string;
}

export interface Limitation {
  code: OrionCode;
  text: string;
  unblock: string | null;
  /** Empty when no app applies. */
  nearestApps: NearestApp[];
}

// ------------------------------------------------------- Pinned viz inputs
// The inputs a viz card mounts, as the snapshot carries them. ProteinPaint's launcher
// arguments are built from these in viz/ppPinnedArgs.ts.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A Gen3 GQL case filter as the wrappers send it, e.g. `{"and":[{"in":{"case_id":[...]}}]}`. */
export type GqlFilter = { [operator: string]: JsonValue };

export type DeMethod = 'wilcoxon' | 'edgeR' | 'limma';

/** A DE group as ProteinPaint integer sample ids (the sandbox maps case n to sample n). */
export interface SampleGroup {
  name: string;
  sampleIds: readonly number[];
}

/** A DEinput group seeded from a saved cohort, as ProteinPaint's Cohort picker builds it. */
export interface CohortGroup {
  name: string;
  cohortId: string;
  filter0: GqlFilter;
}

/** Volcano settings a DE card may pin besides the method (ProteinPaint 2.216.0 setting keys). */
export interface VolcanoPins {
  foldChangeCutoff?: number;
  /** -log10 cutoff. */
  pValue?: number;
  pValueType?: 'adjusted' | 'original';
  /** Declared in 2.216.0's defaults but read by nothing; pinned only to probe Open question 9. */
  rankBy?: string;
}

export type PinnedViz =
  | { kind: 'survival'; filter0: GqlFilter | null; term: string; overlay: string }
  | { kind: 'oncomatrix'; filter0: GqlFilter | null; genes: readonly string[] }
  | {
      kind: 'deDirect';
      /** Control first: fold change is log2(groups[1] / groups[0]). */
      groups: [SampleGroup, SampleGroup];
      method: DeMethod;
      volcano?: VolcanoPins;
    }
  | { kind: 'deInput'; groups: [CohortGroup, CohortGroup] };

export type PinnedKind = PinnedViz['kind'];

export interface VizSpec {
  vizId: string;
  appId: string;
  /** Always equals `pinned.kind`. */
  launcher: PinnedKind;
  citesSteps: string[];
  pinned: PinnedViz;
  /** sha256 of the canonical pinned document (viz/ppPinnedArgs.ts `pinnedHash`). */
  pinnedHash: string;
}

export interface RunView {
  schema: 'orion.run-view/v1';
  threadId: string;
  runId: string;
  revision: number;
  status: RunStatus;
  code: OrionCode | null;
  question: string;
  updatedAt: string;
  plan: Plan | null;
  steps: Step[];
  facts: Fact[];
  observed: Sentence[];
  limitations: Limitation[];
  // The contract fixes only null; non-null shapes arrive with the verifier (Day 2).
  interpretation: Sentence[] | null;
  hypotheses: Sentence[] | null;
  withheldReason: string | null;
  vizSpecs: VizSpec[];
}

// ----------------------------------------------------------------- Events

export interface RunStartedEvent {
  type: 'RUN_STARTED';
  threadId: string;
  runId: string;
}

export interface StateSnapshotEvent {
  type: 'STATE_SNAPSHOT';
  snapshot: RunView;
}

export interface StepStartedEvent {
  type: 'STEP_STARTED';
  stepName: string;
}

export interface StepFinishedEvent {
  type: 'STEP_FINISHED';
  stepName: string;
}

export interface ToolCallStartEvent {
  type: 'TOOL_CALL_START';
  toolCallId: string;
  toolCallName: 'save_cohorts';
}

export interface ToolCallArgsEvent {
  type: 'TOOL_CALL_ARGS';
  toolCallId: string;
  delta: string;
}

export interface ToolCallEndEvent {
  type: 'TOOL_CALL_END';
  toolCallId: string;
}

export interface TextMessageStartEvent {
  type: 'TEXT_MESSAGE_START';
  messageId: string;
  role: 'assistant';
}

export interface TextMessageContentEvent {
  type: 'TEXT_MESSAGE_CONTENT';
  messageId: string;
  delta: string;
}

export interface TextMessageEndEvent {
  type: 'TEXT_MESSAGE_END';
  messageId: string;
}

export interface HeartbeatEvent {
  type: 'CUSTOM';
  name: 'orion.heartbeat';
  value: { ts: string };
}

export interface RunFinishedEvent {
  type: 'RUN_FINISHED';
  threadId: string;
  runId: string;
  result: { status: FinishedStatus | 'Warmed'; code: OrionCode | null };
}

/** Carries no ids: it belongs to the run whose invocation is open. */
export interface RunErrorEvent {
  type: 'RUN_ERROR';
  message: string;
  code: OrionCode;
}

export type AguiEvent =
  | RunStartedEvent
  | StateSnapshotEvent
  | StepStartedEvent
  | StepFinishedEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | HeartbeatEvent
  | RunFinishedEvent
  | RunErrorEvent;

export type AguiEventType = AguiEvent['type'];

export const AGUI_EVENT_TYPES = [
  'RUN_STARTED',
  'STATE_SNAPSHOT',
  'STEP_STARTED',
  'STEP_FINISHED',
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'CUSTOM',
  'RUN_FINISHED',
  'RUN_ERROR',
] as const satisfies readonly AguiEventType[];

// ---------------------------------------------------------------- Request

export interface WireFilterSet {
  mode: 'and' | 'or';
  root: Record<string, unknown>;
}

export interface CohortSnapshot {
  id: string | null;
  name: string;
  filters: WireFilterSet;
  /** null until the platform has counted the cohort. */
  caseCount: number | null;
}

export interface SavedCohortSnapshot extends CohortSnapshot {
  id: string;
}

export interface CohortContext {
  active: CohortSnapshot;
  saved: SavedCohortSnapshot[];
}

export interface SavedCohortReadBack {
  ref: string;
  cohortId: string;
  name: string;
}

export type OrionAction =
  | { action: 'warmup' }
  | { action: 'ask'; question: string; cohortContext: CohortContext }
  | { action: 'cancel' }
  | { action: 'clarify_answer'; optionId: string }
  | { action: 'consent'; accept: boolean }
  | {
      action: 'confirm';
      nonce: string;
      decision: 'create' | 'dont_save';
      saved: SavedCohortReadBack[];
    }
  | { action: 'edit_plan'; field: string; value: string | number }
  | { action: 'retry_step'; stepId: string }
  | {
      action: 'viz_report';
      vizId: string;
      mounted: boolean;
      error: string | null;
    };

export type OrionActionName = OrionAction['action'];

export interface UserMessage {
  id: string;
  role: 'user';
  content: string;
}

/** All seven fields are always present; tools and context stay empty. */
export interface RunAgentInput {
  threadId: string;
  runId: string;
  state: Record<string, never>;
  messages: UserMessage[];
  tools: [];
  context: [];
  forwardedProps: { orion: OrionAction };
}
