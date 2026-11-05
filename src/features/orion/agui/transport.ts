import { createSseParser, type ParseResult } from './sseParser';
import type {
  AguiEvent,
  RunAgentInput,
  RunErrorEvent,
  RunFinishedEvent,
  RunView,
  Step,
  StepStatus,
} from './types';

export const AGUI_ROUTE = '/api/orion/agui';

export type TransportErrorCode = 'NETWORK' | 'NOT_EVENT_STREAM' | 'NO_BODY' | 'ABORTED';

export class TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly status: number | null;

  constructor(code: TransportErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.status = status;
  }
}

/**
 * One turn: posts the input and yields each parsed frame. Malformed frames arrive
 * as `kind: 'error'` items and the stream continues. Rejects with TransportError.
 */
export interface RunTransport {
  run(input: RunAgentInput, signal: AbortSignal): AsyncIterable<ParseResult>;
  /** True when turns replay a recording instead of reaching the agent. */
  readonly replay?: boolean;
}

const aborted = (): TransportError =>
  new TransportError('ABORTED', 'The request was stopped');

const isEventStream = (response: Response): boolean =>
  (response.headers.get('content-type') ?? '')
    .toLowerCase()
    .startsWith('text/event-stream');

const describeResponse = (response: Response): string => {
  if (response.type === 'opaqueredirect') return 'The server redirected the request';
  const type = response.headers.get('content-type') || 'no content type';
  return `HTTP ${response.status} (${type}) instead of an event stream`;
};

export interface HttpTransportOptions {
  url?: string;
  fetchImpl?: typeof fetch;
}

export const httpTransport = ({
  url = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}${AGUI_ROUTE}`,
  fetchImpl,
}: HttpTransportOptions = {}): RunTransport => ({
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
    if (!response.ok || !isEventStream(response)) {
      await response.body?.cancel().catch(() => undefined);
      throw new TransportError(
        'NOT_EVENT_STREAM',
        describeResponse(response),
        response.status,
      );
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

/** Points the recorded ids at the turn being replayed, so the reducer files it under that run. */
const retarget = (event: AguiEvent, input: RunAgentInput): AguiEvent => {
  const ids = { threadId: input.threadId, runId: input.runId };
  switch (event.type) {
    case 'RUN_STARTED':
    case 'RUN_FINISHED':
      return { ...event, ...ids };
    case 'STATE_SNAPSHOT':
      return { ...event, snapshot: { ...event.snapshot, ...ids } };
    default:
      return event;
  }
};

export interface FixtureTransportOptions {
  /** Defaults to the bundled J1 stream, loaded on first use so other modes never ship it. */
  stream?: string;
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
const RUN_NOT_FOUND_MESSAGE = 'No run with this runId exists in this thread.';
const UNFINISHED: ReadonlySet<StepStatus> = new Set(['Queued', 'AwaitingUser', 'Running', 'Retrying']);

const cancelReply = (input: RunAgentInput, run: ReplayedRun | undefined): AguiEvent[] => {
  if (!run) return [{ type: 'RUN_ERROR', code: 'RUN_NOT_FOUND', message: RUN_NOT_FOUND_MESSAGE }];
  const { view, terminal } = run;
  if (terminal) return view ? [{ type: 'STATE_SNAPSHOT', snapshot: view }, terminal] : [terminal];
  const cancelled: RunFinishedEvent = {
    type: 'RUN_FINISHED',
    threadId: input.threadId,
    runId: input.runId,
    result: { status: 'Cancelled', code: null },
  };
  if (!view) return [cancelled];
  const stopped: RunView = {
    ...view,
    revision: view.revision + 1,
    status: 'Cancelled',
    code: null,
    updatedAt: new Date().toISOString(),
    // A replay has no output for the step it stopped in, so that step is skipped too.
    steps: view.steps.map((step): Step =>
      UNFINISHED.has(step.status)
        ? { ...step, status: 'Skipped', outputSummary: STOPPED_SUMMARY }
        : step,
    ),
  };
  return [{ type: 'STATE_SNAPSHOT', snapshot: stopped }, cancelled];
};

/**
 * Replays the bundled J1 reference stream for `ask`, frame by frame through the
 * SSE parser, whatever the question. `cancel` answers like the agent: RUN_NOT_FOUND
 * for a run this transport never replayed. Other actions get the minimal reply the
 * contract defines for them.
 */
export const fixtureTransport = ({
  stream,
  delayMs = 250,
}: FixtureTransportOptions = {}): RunTransport => {
  const replayed = new Map<string, ReplayedRun>();
  const key = ({ threadId, runId }: RunAgentInput) => `${threadId}/${runId}`;
  return {
    replay: true,
    async *run(input, signal) {
      const { action } = input.forwardedProps.orion;
      if (action === 'ask') {
        const run: ReplayedRun = { view: null, terminal: null };
        replayed.set(key(input), run);
        const recorded = stream ?? (await loadJ1Stub());
        const parser = createSseParser();
        for (const frame of splitFrames(recorded)) {
          await sleep(delayMs, signal);
          for (const item of parser.push(frame)) {
            if (item.kind === 'error') {
              yield item;
              continue;
            }
            const event = retarget(item.event, input);
            if (event.type === 'STATE_SNAPSHOT') run.view = event.snapshot;
            if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') run.terminal = event;
            yield { kind: 'event', event };
          }
        }
        return;
      }
      await sleep(delayMs, signal);
      yield { kind: 'event', event: { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId } };
      const replies: AguiEvent[] =
        action === 'warmup'
          ? [
              {
                type: 'RUN_FINISHED',
                threadId: input.threadId,
                runId: input.runId,
                result: { status: 'Warmed', code: null },
              },
            ]
          : action === 'cancel'
            ? cancelReply(input, replayed.get(key(input)))
            : [{ type: 'RUN_ERROR', message: `${action} is not in the fixture`, code: 'NOT_IMPLEMENTED' }];
      for (const event of replies) yield { kind: 'event', event };
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
