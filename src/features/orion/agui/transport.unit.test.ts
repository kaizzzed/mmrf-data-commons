import { readFileSync } from 'fs';
import { createThread, threadReducer } from './reducer';
import type { ParseResult } from './sseParser';
import {
  fixtureTransport,
  httpTransport,
  selectTransport,
  TransportError,
  type RunTransport,
} from './transport';
import type { AguiEvent, RunAgentInput } from './types';
import { J1_STUB_STREAM } from './__fixtures__/j1Stub';
import { FIXTURE_PATH } from '../testing';

const THREAD = '0123456789abcdef0123456789abcdef';
const RUN = 'fedcba9876543210fedcba9876543210';

const input = (action: 'ask' | 'warmup' | 'cancel' = 'ask', runId = RUN): RunAgentInput => ({
  threadId: THREAD,
  runId,
  state: {},
  messages: action === 'ask' ? [{ id: 'm1', role: 'user', content: 'q' }] : [],
  tools: [],
  context: [],
  forwardedProps: {
    orion:
      action === 'ask'
        ? {
            action: 'ask',
            question: 'q',
            cohortContext: {
              active: { id: null, name: 'All cases', filters: { mode: 'and', root: {} }, caseCount: 1000 },
              saved: [],
            },
          }
        : { action },
  },
});

const collect = async (transport: RunTransport, signal = new AbortController().signal) => {
  const items: ParseResult[] = [];
  for await (const item of transport.run(input(), signal)) items.push(item);
  return items;
};

const failure = async (promise: Promise<unknown>): Promise<TransportError> => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof TransportError) return err;
    throw err;
  }
  throw new Error('expected a TransportError');
};

const respond = (response: Response) =>
  jest.fn<Promise<Response>, Parameters<typeof fetch>>(async () => response);

const FRAME = `data: {"type":"RUN_STARTED","threadId":"${THREAD}","runId":"${RUN}"}\n\n`;

describe('httpTransport', () => {
  it('posts all seven RunAgentInput fields and yields parsed events', async () => {
    const fetchImpl = respond(
      new Response(FRAME, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }),
    );
    const items = await collect(httpTransport({ url: '/api/orion/agui', fetchImpl }));
    expect(items).toEqual([
      { kind: 'event', event: { type: 'RUN_STARTED', threadId: THREAD, runId: RUN } },
    ]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/orion/agui');
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(Object.keys(JSON.parse(String(init?.body))).sort()).toEqual(
      ['context', 'forwardedProps', 'messages', 'runId', 'state', 'threadId', 'tools'],
    );
  });

  it.each([
    ['a 400 JSON body', new Response('{"code":"INVALID_INPUT"}', { status: 400, headers: { 'Content-Type': 'application/json' } }), 400],
    ['a 307 redirect', new Response(null, { status: 307, headers: { Location: '/terms' } }), 307],
    ['a 200 HTML page', new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }), 200],
  ])('rejects %s as a transport error', async (_label, response, status) => {
    const err = await failure(collect(httpTransport({ fetchImpl: respond(response) })));
    expect(err.code).toBe('NOT_EVENT_STREAM');
    expect(err.status).toBe(status);
  });

  it('reports a failed fetch as a network error', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await failure(collect(httpTransport({ fetchImpl })));
    expect(err.code).toBe('NETWORK');
  });

  it('stops reading and cancels the body when aborted mid-stream', async () => {
    const cancel = jest.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(FRAME));
      },
      cancel,
    });
    const fetchImpl = respond(
      new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    const abort = new AbortController();
    const seen: ParseResult[] = [];
    const run = (async () => {
      for await (const item of httpTransport({ fetchImpl }).run(input(), abort.signal)) {
        seen.push(item);
        abort.abort();
      }
    })();
    const err = await failure(run);
    expect(err.code).toBe('ABORTED');
    expect(seen).toHaveLength(1);
    expect(cancel).toHaveBeenCalled();
  });
});

describe('fixtureTransport', () => {
  it('bundles a byte-for-byte copy of the reference stream', () => {
    expect(Buffer.from(J1_STUB_STREAM, 'utf8').equals(readFileSync(FIXTURE_PATH))).toBe(true);
  });

  it('replays the J1 stream under the ids of the turn it answers', async () => {
    const items = await collect(fixtureTransport({ delayMs: 0 }));
    expect(items).toHaveLength(22);
    const state = items.reduce(
      (thread, item) => (item.kind === 'event' ? threadReducer(thread, item.event) : thread),
      createThread(THREAD),
    );
    expect(state.runIds).toEqual([RUN]);
    expect(state.runs[RUN].status).toBe('ObservedOnly');
  });

  it('answers a warm-up with RUN_STARTED and RUN_FINISHED Warmed', async () => {
    const items: ParseResult[] = [];
    for await (const item of fixtureTransport({ delayMs: 0 }).run(
      input('warmup'),
      new AbortController().signal,
    )) {
      items.push(item);
    }
    expect(items.map((i) => (i.kind === 'event' ? i.event.type : i.kind))).toEqual([
      'RUN_STARTED',
      'RUN_FINISHED',
    ]);
  });

  const events = async (
    transport: RunTransport,
    turn: RunAgentInput,
    signal = new AbortController().signal,
  ): Promise<AguiEvent[]> => {
    const seen: AguiEvent[] = [];
    for await (const item of transport.run(turn, signal)) {
      if (item.kind === 'event') seen.push(item.event);
    }
    return seen;
  };

  it('answers a cancel for a run it never replayed with RUN_NOT_FOUND, as the agent does', async () => {
    const seen = await events(fixtureTransport({ delayMs: 0 }), input('cancel'));
    expect(seen.map((e) => e.type)).toEqual(['RUN_STARTED', 'RUN_ERROR']);
    expect(seen[1]).toMatchObject({ code: 'RUN_NOT_FOUND' });
  });

  it('ends a stopped replay Cancelled, with every unfinished step skipped', async () => {
    const transport = fixtureTransport({ delayMs: 0 });
    const abort = new AbortController();
    let thread = createThread(THREAD);
    const replay = (async () => {
      for await (const item of transport.run(input(), abort.signal)) {
        if (item.kind !== 'event') continue;
        thread = threadReducer(thread, item.event);
        if (item.event.type === 'STATE_SNAPSHOT' && item.event.snapshot.revision === 4) abort.abort();
      }
    })();
    expect((await failure(replay)).code).toBe('ABORTED');
    thread = threadReducer(thread, { type: 'stop', runId: RUN });

    const reply = await events(transport, input('cancel'));
    expect(reply.map((e) => e.type)).toEqual(['RUN_STARTED', 'STATE_SNAPSHOT', 'RUN_FINISHED']);
    thread = reply.reduce(threadReducer, thread);
    const run = thread.runs[RUN];
    expect(run.status).toBe('Cancelled');
    expect(run.view?.revision).toBe(5);
    expect(run.view?.steps.map((s) => [s.id, s.status])).toEqual([
      ['s1', 'Done'],
      ['s2', 'Skipped'],
      ['s3', 'Skipped'],
      ['s4', 'Skipped'],
      ['s5', 'Skipped'],
    ]);
  });

  it('answers a cancel after the replay ended with how it ended', async () => {
    const transport = fixtureTransport({ delayMs: 0 });
    await events(transport, input());
    const reply = await events(transport, input('cancel'));
    expect(reply.map((e) => e.type)).toEqual(['RUN_STARTED', 'STATE_SNAPSHOT', 'RUN_FINISHED']);
    expect(reply[2]).toMatchObject({ result: { status: 'ObservedOnly' } });
  });

  it('stops replaying when aborted', async () => {
    const abort = new AbortController();
    const run = (async () => {
      for await (const item of fixtureTransport({ delayMs: 5 }).run(input(), abort.signal)) {
        if (item.kind === 'event') abort.abort();
      }
    })();
    expect((await failure(run)).code).toBe('ABORTED');
  });
});

describe('selectTransport', () => {
  it('replays the fixture only for orion=fixture', () => {
    expect(selectTransport('?app=Assistant&orion=fixture').replay).toBe(true);
    expect(selectTransport('?app=Assistant').replay).toBeFalsy();
  });

  it('ignores orion=fixture in a production build outside the synthetic sandbox', () => {
    const env = process.env;
    const replaced = jest.replaceProperty(process, 'env', {
      ...env,
      NODE_ENV: 'production',
      NEXT_PUBLIC_SYNTHETIC_SANDBOX: '',
    });
    try {
      expect(selectTransport('?orion=fixture').replay).toBeFalsy();
      replaced.replaceValue({ ...env, NODE_ENV: 'production', NEXT_PUBLIC_SYNTHETIC_SANDBOX: '1' });
      expect(selectTransport('?orion=fixture').replay).toBe(true);
    } finally {
      replaced.restore();
    }
  });
});
