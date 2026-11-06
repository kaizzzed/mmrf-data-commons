/** @jest-environment node */
import { createFrameScanner, type SeenFrame } from './frames';
import { parseTurn, PREEMPTING_ACTIONS } from './runInput';
import { SessionRegistry } from './sessions';
import { readFixture } from './testHarness';

const scanAll = (bytes: Buffer, size: number): SeenFrame[] => {
  const scanner = createFrameScanner();
  const frames: SeenFrame[] = [];
  for (let i = 0; i < bytes.length; i += size) frames.push(...scanner.push(bytes.subarray(i, i + size)));
  return frames;
};

describe('the relay frame scanner', () => {
  it('sees every frame of a fixture however the bytes are cut', () => {
    const bytes = readFixture('j1-stop.events.jsonl');
    const whole = scanAll(bytes, bytes.length);
    expect(whole.map((frame) => frame.type)).toEqual([
      'OTHER',
      'STATE_SNAPSHOT',
      'STATE_SNAPSHOT',
      'STATE_SNAPSHOT',
      'RUN_FINISHED',
    ]);
    expect(whole[1]).toEqual({ type: 'STATE_SNAPSHOT', runId: 'd0120840e82e4f6db72c9a7d31fe0a00', status: 'Stopping' });
    expect(whole[3]).toEqual({ type: 'STATE_SNAPSHOT', runId: 'd0120840e82e4f6db72c9a7d31fe0a00', status: 'Cancelled' });
    expect(whole[4]).toEqual({ type: 'RUN_FINISHED', runId: 'd0120840e82e4f6db72c9a7d31fe0a00', status: 'Cancelled' });
    for (const size of [1, 2, 3, 7, 1000]) expect(scanAll(bytes, size)).toEqual(whole);
  });

  it('accepts CRLF split across chunks, comments and other fields', () => {
    const scanner = createFrameScanner();
    expect(scanner.push(Buffer.from(': ping\r\nevent: x\r\ndata: {"type":"RUN_ERROR","code":"X","message":"m"}\r'))).toEqual(
      [],
    );
    expect(scanner.push(Buffer.from('\n\r\n'))).toEqual([{ type: 'RUN_ERROR' }]);
  });

  it('ignores malformed data', () => {
    const scanner = createFrameScanner();
    expect(scanner.push(Buffer.from('data: {nope\n\ndata: 3\n\ndata: {"type":"STATE_SNAPSHOT"}\n\n'))).toEqual([]);
  });
});

describe('the session registry', () => {
  const THREAD = '0123456789abcdef0123456789abcdef';
  const RUN = 'fedcba9876543210fedcba9876543210';

  it('holds one call per thread; only cancel, edit_plan and confirm preempt it', () => {
    expect([...PREEMPTING_ACTIONS].sort()).toEqual(['cancel', 'confirm', 'edit_plan']);
    const sessions = new SessionRegistry();
    const first = sessions.claim(THREAD, RUN, 'ask');
    expect(first?.preempted).toBeNull();
    for (const action of ['ask', 'warmup', 'viz_report', 'retry_step', 'clarify_answer', 'consent'] as const) {
      expect(sessions.claim(THREAD, RUN, action)).toBeNull();
    }
    expect(sessions.claim('ab'.repeat(16), RUN, 'ask')).not.toBeNull();
    const cancel = sessions.claim(THREAD, RUN, 'cancel');
    expect(cancel?.preempted).toBe(first?.call);
    expect(first?.call.controller.signal.aborted).toBe(true);
    expect(sessions.current(THREAD)).toBe(cancel?.call);
    // The aborted call closing does not free the session its successor holds.
    if (first) sessions.release(first.call);
    expect(sessions.current(THREAD)).toBe(cancel?.call);
    if (cancel) sessions.release(cancel.call);
    expect(sessions.current(THREAD)).toBeUndefined();
  });

  it('resolves closed when a call is released', async () => {
    const sessions = new SessionRegistry();
    const claim = sessions.claim(THREAD, RUN, 'ask');
    if (!claim) throw new Error('not claimed');
    let closed = false;
    void claim.call.closed.then(() => {
      closed = true;
    });
    sessions.release(claim.call);
    await claim.call.closed;
    expect(closed).toBe(true);
  });
});

describe('the turn envelope', () => {
  it('accepts every request example, keeping the bytes', () => {
    const { examples } = JSON.parse(readFixture('request-examples.json').toString('utf8')) as {
      examples: { body: { threadId: string; runId: string; forwardedProps: { orion: { action: string } } } }[];
    };
    for (const { body } of examples) {
      const bytes = Buffer.from(JSON.stringify(body));
      expect(parseTurn(bytes)).toEqual({
        threadId: body.threadId,
        runId: body.runId,
        action: body.forwardedProps.orion.action,
        bytes,
      });
    }
  });
});
