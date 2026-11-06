import {
  aguiUrl,
  isEventStream,
  readBffError,
  recordUrl,
  viewUrl,
  type BffErrorAction,
} from '../server/routes';
import { createSseParser, type ParseResult } from './sseParser';
import {
  BFF_ERROR_HANDLING,
  END_STATUSES,
  WAITING_STATUSES,
  type AguiEvent,
  type BffErrorCode,
  type OrionActionName,
  type RunAgentInput,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunRecord,
  type RunStatus,
  type RunView,
  type Step,
  type StepStatus,
} from './types';

// Route paths, the stream check and BffError parsing come from the BFF's own client helpers
// (server/routes.ts), so both sides agree on them.

export type TransportErrorCode =
  | 'NETWORK'
  | 'NOT_EVENT_STREAM'
  | 'NOT_JSON'
  | 'NO_BODY'
  | 'ABORTED'
  /** The BFF answered with its JSON error body; `bffCode` says which. */
  | 'BFF_ERROR';

export class TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly status: number | null;
  /** Set exactly when code is BFF_ERROR: the contract code the BFF's JSON error body carries. */
  readonly bffCode: BffErrorCode | null;

  constructor(
    code: TransportErrorCode,
    message: string,
    status: number | null = null,
    bffCode: BffErrorCode | null = null,
  ) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.status = status;
    this.bffCode = bffCode;
  }
}

/** What the browser does with a BFF error code (contract "Client handling of BFF errors"). */
export const bffHandling = (code: BffErrorCode): BffErrorAction => BFF_ERROR_HANDLING[code];

/**
 * One turn: posts the input and yields each parsed frame. Malformed frames arrive
 * as `kind: 'error'` items and the stream continues. Rejects with TransportError.
 */
export interface RunTransport {
  run(input: RunAgentInput, signal: AbortSignal): AsyncIterable<ParseResult>;
  /** True when turns replay a recording instead of reaching the agent. */
  readonly replay?: boolean;
  /** The view and record routes; absent when there is no BFF behind the transport (a replay). */
  readonly routes?: RunRoutes;
}

/** The two GET routes: the run's untrimmed view (expired-lease rule applied) and its record. */
export interface RunRoutes {
  view(runId: string, threadId: string, signal?: AbortSignal): Promise<RunView>;
  record(runId: string, threadId: string, signal?: AbortSignal): Promise<RunRecord>;
  /** The record route with `?download=1`, for the JSON export link. */
  recordDownloadHref(runId: string, threadId: string): string;
}

const aborted = (): TransportError =>
  new TransportError('ABORTED', 'The request was stopped');

const describeResponse = (response: Response, expected: string): string => {
  if (response.type === 'opaqueredirect') return 'The server redirected the request';
  const type = response.headers.get('content-type') || 'no content type';
  return `HTTP ${response.status} (${type}) instead of ${expected}`;
};

/** The error a failed response stands for: the BFF's own code when its body carries one. */
const responseError = async (response: Response, expected: string, fallback: TransportErrorCode) => {
  const bff = await readBffError(response);
  if (!bff) await response.body?.cancel().catch(() => undefined);
  return bff
    ? new TransportError('BFF_ERROR', bff.error.message, response.status, bff.error.code)
    : new TransportError(fallback, describeResponse(response, expected), response.status);
};

export interface HttpRoutesOptions {
  /** Defaults to NEXT_PUBLIC_BASE_PATH (server/routes.ts). */
  basePath?: string;
  fetchImpl?: typeof fetch;
}

const isRunView = (value: unknown): value is RunView =>
  typeof value === 'object' && value !== null && (value as { schema?: unknown }).schema === 'orion.run-view/v1';

const isRunRecord = (value: unknown): value is RunRecord =>
  typeof value === 'object' && value !== null && (value as { schema?: unknown }).schema === 'orion.run-record/v1';

export const httpRoutes = ({ basePath, fetchImpl }: HttpRoutesOptions = {}): RunRoutes => {
  const getJson = async <T>(path: string, signal: AbortSignal | undefined, check: (value: unknown) => value is T) => {
    const doFetch = fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(path, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw aborted();
      throw new TransportError('NETWORK', err instanceof Error ? err.message : 'Network error');
    }
    if (!response.ok) throw await responseError(response, 'JSON', 'NOT_JSON');
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      if (signal?.aborted) throw aborted();
      throw new TransportError('NOT_JSON', 'The response body is not JSON', response.status);
    }
    if (!check(value)) throw new TransportError('NOT_JSON', 'The response is not the expected document', response.status);
    return value;
  };

  return {
    view: (runId, threadId, signal) => getJson(viewUrl(runId, { basePath, threadId }), signal, isRunView),
    record: (runId, threadId, signal) => getJson(recordUrl(runId, { basePath, threadId }), signal, isRunRecord),
    recordDownloadHref: (runId, threadId) => recordUrl(runId, { basePath, threadId, download: true }),
  };
};

export interface HttpTransportOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  routes?: RunRoutes;
}

export const httpTransport = ({
  url = aguiUrl(),
  fetchImpl,
  routes = httpRoutes({ fetchImpl }),
}: HttpTransportOptions = {}): RunTransport => ({
  routes,
  async *run(input, signal) {
    const doFetch = fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(input),
        credentials: 'same-origin',
        cache: 'no-store',
        // A terms redirect must surface as an error, not re-post the turn elsewhere.
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw aborted();
      throw new TransportError(
        'NETWORK',
        err instanceof Error ? err.message : 'Network error',
      );
    }
    if (!response.ok || !isEventStream(response.headers.get('content-type'))) {
      throw await responseError(response, 'an event stream', 'NOT_EVENT_STREAM');
    }
    if (!response.body) throw new TransportError('NO_BODY', 'The response has no body');

    const reader = response.body.getReader();
    const read = async () => {
      try {
        return await reader.read();
      } catch (err) {
        if (signal.aborted) throw aborted();
        throw new TransportError(
          'NETWORK',
          err instanceof Error ? err.message : 'The stream failed',
        );
      }
    };
    const onAbort = () => {
      reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort);
    const parser = createSseParser();
    let finished = false;
    try {
      for (;;) {
        const chunk = await read();
        if (signal.aborted) throw aborted();
        if (chunk.done) {
          finished = true;
          return;
        }
        yield* parser.push(chunk.value);
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (!finished) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  },
});

// ------------------------------------------------------------------ fixture replay

/** Splits a recorded stream after each blank line, keeping the terminators. */
const splitFrames = (stream: string): string[] => {
  const frames: string[] = [];
  let start = 0;
  for (let end = stream.indexOf('\n\n'); end !== -1; end = stream.indexOf('\n\n', start)) {
    frames.push(stream.slice(start, end + 2));
    start = end + 2;
  }
  if (start < stream.length) frames.push(stream.slice(start));
  return frames;
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(aborted());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Points the recorded ids at the turn being replayed, so the reducer files it under that run. A
 * snapshot of another run (an earlier run a stream reports first) keeps its own run id.
 */
const retarget = (event: AguiEvent, input: RunAgentInput, recordedRunId: string | null): AguiEvent => {
  const ids = { threadId: input.threadId, runId: input.runId };
  switch (event.type) {
    case 'RUN_STARTED':
    case 'RUN_FINISHED':
      return { ...event, ...ids };
    case 'STATE_SNAPSHOT':
      return {
        ...event,
        snapshot: {
          ...event.snapshot,
          threadId: input.threadId,
          runId: recordedRunId === null || event.snapshot.runId === recordedRunId ? input.runId : event.snapshot.runId,
        },
      };
    default:
      return event;
  }
};

export interface FixtureTransportOptions {
  /** The `ask` reply. Defaults to the bundled J1 stream, loaded on first use so other modes never ship it. */
  stream?: string;
  /** Recorded replies to other actions, such as `confirm`, replayed under the turn's ids. */
  replies?: Partial<Record<Exclude<OrionActionName, 'ask' | 'cancel' | 'warmup'>, string>>;
  delayMs?: number;
}

const loadJ1Stub = async (): Promise<string> =>
  (await import('./__fixtures__/j1Stub')).J1_STUB_STREAM;

/** What a replay has sent for one run, so a later cancel can answer the way the agent would. */
interface ReplayedRun {
  view: RunView | null;
  terminal: RunFinishedEvent | RunErrorEvent | null;
}

// The agent's wording (controller.py STOPPED_SUMMARY and its RUN_NOT_FOUND message).
const STOPPED_SUMMARY = 'Not run: stopped';
const STOPPED_REASON = 'you stopped the run';
const RUN_NOT_FOUND_MESSAGE = 'No run with this runId exists in this thread.';
const UNFINISHED: ReadonlySet<StepStatus> = new Set(['Queued', 'AwaitingUser', 'Running', 'Retrying']);
const END: ReadonlySet<RunStatus> = new Set(END_STATUSES);
const WAITING: ReadonlySet<RunStatus> = new Set(WAITING_STATUSES);

/** The run as the agent records it Cancelled: unfinished steps skipped, finished ones kept. */
const cancelledView = (view: RunView, revision: number): RunView => ({
  ...view,
  revision,
  status: 'Cancelled',
  code: null,
  updatedAt: new Date().toISOString(),
  pending: null,
  withheldReason: view.observed.length > 0 ? STOPPED_REASON : null,
  // A replay has no output for the step it stopped in, so that step is skipped too.
  steps: view.steps.map((step): Step =>
    UNFINISHED.has(step.status)
      ? { ...step, status: 'Skipped', outputSummary: STOPPED_SUMMARY, code: null, durationMs: null }
      : step,
  ),
});

/**
 * The agent's reply to `cancel` (contract "What the agent emits on a resume"): a live run shows
 * Stopping at once, then Cancelled; a waiting run is Cancelled at once; an ended run replays its
 * snapshot and terminal event; a run this replay never sent is RUN_NOT_FOUND.
 */
const cancelReply = (input: RunAgentInput, run: ReplayedRun | undefined): AguiEvent[] => {
  if (!run) return [{ type: 'RUN_ERROR', code: 'RUN_NOT_FOUND', message: RUN_NOT_FOUND_MESSAGE }];
  const finished = (status: 'Cancelled'): RunFinishedEvent => ({
    type: 'RUN_FINISHED',
    threadId: input.threadId,
    runId: input.runId,
    result: { status, code: null },
  });
  const { view, terminal } = run;
  if (!view) return [terminal ?? finished('Cancelled')];
  if (END.has(view.status)) {
    return [{ type: 'STATE_SNAPSHOT', snapshot: view }, terminal ?? finished('Cancelled')];
  }
  if (WAITING.has(view.status)) {
    return [{ type: 'STATE_SNAPSHOT', snapshot: cancelledView(view, view.revision + 1) }, finished('Cancelled')];
  }
  const stopping: RunView = {
    ...view,
    revision: view.revision + 1,
    status: 'Stopping',
    code: null,
    updatedAt: new Date().toISOString(),
  };
  return [
    { type: 'STATE_SNAPSHOT', snapshot: stopping },
    { type: 'STATE_SNAPSHOT', snapshot: cancelledView(stopping, stopping.revision + 1) },
    finished('Cancelled'),
  ];
};

/** The run id a recorded stream's RUN_STARTED names, so its other runs keep their ids. */
const recordedRunIdOf = (stream: string): string | null => {
  const match = /"type":"RUN_STARTED"[^}]*"runId":"([0-9a-f]{32})"/.exec(stream);
  return match ? match[1] : null;
};

/**
 * Replays the bundled J1 reference stream for `ask`, frame by frame through the SSE parser,
 * whatever the question, and any recorded `replies` for other actions. `cancel` answers like the
 * agent; a standalone `viz_report` ends Recorded; other actions get NOT_IMPLEMENTED.
 */
export const fixtureTransport = ({
  stream,
  replies = {},
  delayMs = 250,
}: FixtureTransportOptions = {}): RunTransport => {
  const replayed = new Map<string, ReplayedRun>();
  const key = ({ threadId, runId }: RunAgentInput) => `${threadId}/${runId}`;
  return {
    replay: true,
    async *run(input, signal) {
      const { action } = input.forwardedProps.orion;
      const recording =
        action === 'ask' ? (stream ?? (await loadJ1Stub())) : action !== 'cancel' && action !== 'warmup' ? replies[action] : undefined;
      if (recording !== undefined) {
        const run: ReplayedRun = replayed.get(key(input)) ?? { view: null, terminal: null };
        run.terminal = null;
        replayed.set(key(input), run);
        const recordedRunId = recordedRunIdOf(recording);
        const parser = createSseParser();
        for (const frame of splitFrames(recording)) {
          await sleep(delayMs, signal);
          for (const item of parser.push(frame)) {
            if (item.kind === 'error') {
              yield item;
              continue;
            }
            const event = retarget(item.event, input, recordedRunId);
            if (event.type === 'STATE_SNAPSHOT' && event.snapshot.runId === input.runId) run.view = event.snapshot;
            if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') run.terminal = event;
            yield { kind: 'event', event };
          }
        }
        return;
      }
      await sleep(delayMs, signal);
      yield { kind: 'event', event: { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId } };
      const finished = (status: 'Warmed' | 'Recorded'): AguiEvent => ({
        type: 'RUN_FINISHED',
        threadId: input.threadId,
        runId: input.runId,
        result: { status, code: null },
      });
      let answer: AguiEvent[];
      if (action === 'warmup') answer = [finished('Warmed')];
      else if (action === 'viz_report') answer = [finished('Recorded')];
      else if (action === 'cancel') {
        const run = replayed.get(key(input));
        answer = cancelReply(input, run);
        for (const event of answer) {
          if (!run) break;
          if (event.type === 'STATE_SNAPSHOT') run.view = event.snapshot;
          if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') run.terminal = event;
        }
      } else {
        answer = [{ type: 'RUN_ERROR', message: `${action} is not in the fixture`, code: 'NOT_IMPLEMENTED' }];
      }
      for (const event of answer) yield { kind: 'event', event };
    },
  };
};

/** The replay's numbers are stub values, so it stays out of real production builds. */
const fixtureAllowed = (): boolean =>
  process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_SYNTHETIC_SANDBOX === '1';

export const selectTransport = (search: string): RunTransport =>
  fixtureAllowed() && new URLSearchParams(search).get('orion') === 'fixture'
    ? fixtureTransport()
    : httpTransport();
