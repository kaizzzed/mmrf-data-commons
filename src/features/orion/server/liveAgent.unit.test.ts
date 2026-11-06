/** @jest-environment node */
// Opt-in: the three routes against a running orion-agent container (mode L) and its run volume.
// Skipped unless ORION_BFF_LIVE_AGENT_URL and ORION_BFF_LIVE_RUN_DIR are set, for example:
//   ORION_BFF_LIVE_AGENT_URL=http://orion-agent:8080 ORION_BFF_LIVE_RUN_DIR=/data/runs npx jest liveAgent
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { AguiEvent, RunView } from '../agui/types';
import { newId } from '../ids';
import { createAguiHandler, createRecordHandler, createViewHandler, type HandlerDeps } from './handlers';
import { setLogger, type Logger } from './log';
import { DEFAULT_TIMERS } from './relay';
import { SessionRegistry } from './sessions';
import { parseFrames, postTurn, RUN_ROUTE, send, serveRoute, sseFrames, TEST_CREDENTIALS, type Listening } from './testHarness';

const AGENT = process.env.ORION_BFF_LIVE_AGENT_URL;
const RUN_DIR = process.env.ORION_BFF_LIVE_RUN_DIR;
const live = AGENT && RUN_DIR ? describe : describe.skip;

live('the BFF against a live orion-agent (mode L)', () => {
  let routes: Listening[] = [];
  let restore: Logger;
  const deps = (): HandlerDeps => ({
    authenticate: async () => true,
    config: () => ({ mode: 'L', agentUrl: new URL(AGENT as string), runDir: RUN_DIR as string }),
    credentials: async () => TEST_CREDENTIALS,
    sessions: new SessionRegistry(),
    timers: DEFAULT_TIMERS,
    now: Date.now,
  });

  beforeAll(() => {
    restore = setLogger(() => undefined);
  });
  afterAll(async () => {
    await Promise.all(routes.map((route) => route.close()));
    routes = [];
    setLogger(restore);
  });

  const cohortContext = {
    active: { id: null, name: 'All cases', filters: { mode: 'and', root: {} }, caseCount: null },
    saved: [],
  };
  const turn = (threadId: string, runId: string, orion: Record<string, unknown>, question?: string) => ({
    threadId,
    runId,
    state: {},
    messages: question ? [{ id: newId(), role: 'user', content: question }] : [],
    tools: [],
    context: [],
    forwardedProps: { orion },
  });

  it('streams an ask, then serves its view and record from the volume', async () => {
    const agui = await serveRoute(createAguiHandler(deps()));
    const view = await serveRoute(createViewHandler(deps()), RUN_ROUTE);
    const record = await serveRoute(createRecordHandler(deps()), RUN_ROUTE);
    routes.push(agui, view, record);
    const threadId = newId();

    const warm = await postTurn(agui.url, turn(threadId, newId(), { action: 'warmup' }));
    expect(warm.status).toBe(200);
    expect(parseFrames(warm.body).at(-1)).toMatchObject({ type: 'RUN_FINISHED', result: { status: 'Warmed' } });

    const runId = newId();
    const question = 'Compare survival of CGS high-risk vs. CGS standard-risk patients';
    const raw = await postTurn(agui.url, turn(threadId, runId, { action: 'ask', question, cohortContext }, question));
    expect(raw.status).toBe(200);
    expect(raw.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    const frames = parseFrames(raw.body) as unknown as AguiEvent[];
    expect(frames[0]).toEqual({ type: 'RUN_STARTED', threadId, runId });
    expect(['RUN_FINISHED', 'RUN_ERROR']).toContain(frames.at(-1)?.type);
    for (const frame of sseFrames(raw.body)) expect(frame.length).toBeLessThanOrEqual(32 * 1024);
    const last = frames.filter((f) => f.type === 'STATE_SNAPSHOT').at(-1);
    if (last?.type !== 'STATE_SNAPSHOT') throw new Error('no snapshot');

    const served = await send(`${view.url}/api/orion/runs/${runId}/view?threadId=${threadId}`);
    expect(served.status).toBe(200);
    expect((JSON.parse(served.body.toString('utf8')) as RunView).revision).toBe(last.snapshot.revision);
    const exported = await send(`${record.url}/api/orion/runs/${runId}/record?download=1`);
    expect(exported.status).toBe(200);
    expect(exported.body.equals(readFileSync(path.join(RUN_DIR as string, 'runs', `${runId}.json`)))).toBe(true);
    expect((await send(`${view.url}/api/orion/runs/${runId}/view?threadId=${newId()}`)).status).toBe(404);

    // A cancel of the ended run: its snapshot and terminal event, nothing changes.
    const cancel = await postTurn(agui.url, turn(threadId, runId, { action: 'cancel' }));
    expect(cancel.status).toBe(200);
    expect(parseFrames(cancel.body).at(-1)?.type).toMatch(/^RUN_(FINISHED|ERROR)$/);
  });
});
