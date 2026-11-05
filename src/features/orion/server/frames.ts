// Watches the relayed SSE bytes without changing them: the relay needs to know when a run's
// Cancelled snapshot or the invocation's terminal event has passed (the Stop grace, C-18).

import type { RunStatus } from '../agui/types';

export type SeenFrame =
  | { type: 'STATE_SNAPSHOT'; runId: string; status: RunStatus }
  | { type: 'RUN_FINISHED'; runId: string; status: string }
  | { type: 'RUN_ERROR' }
  | { type: 'OTHER' };

export interface FrameScanner {
  /** Feeds one relayed chunk; returns the frames it completed. */
  push(chunk: Uint8Array): SeenFrame[];
}

const describe = (data: string): SeenFrame | null => {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const event = value as {
    type?: unknown;
    runId?: unknown;
    snapshot?: { runId?: unknown; status?: unknown };
    result?: { status?: unknown };
  };
  switch (event.type) {
    case 'STATE_SNAPSHOT':
      return typeof event.snapshot?.runId === 'string' && typeof event.snapshot.status === 'string'
        ? { type: 'STATE_SNAPSHOT', runId: event.snapshot.runId, status: event.snapshot.status as RunStatus }
        : null;
    case 'RUN_FINISHED':
      return typeof event.runId === 'string' && typeof event.result?.status === 'string'
        ? { type: 'RUN_FINISHED', runId: event.runId, status: event.result.status }
        : null;
    case 'RUN_ERROR':
      return { type: 'RUN_ERROR' };
    default:
      return { type: 'OTHER' };
  }
};

const MAX_PENDING_CHARS = 1024 * 1024;

/** WHATWG SSE framing: frames end at a blank line; only `data:` fields matter; CRLF accepted. */
export const createFrameScanner = (): FrameScanner => {
  const decoder = new TextDecoder();
  let buffer = '';
  // A chunk ending in CR may continue with LF; hold the CR back until the next chunk.
  let heldCr = false;
  return {
    push(chunk) {
      let text = (heldCr ? '\r' : '') + decoder.decode(chunk, { stream: true });
      heldCr = text.endsWith('\r');
      if (heldCr) text = text.slice(0, -1);
      buffer += text.replace(/\r\n?/g, '\n');
      const frames: SeenFrame[] = [];
      for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
          .join('\n');
        if (!data) continue;
        const frame = describe(data);
        if (frame) frames.push(frame);
      }
      // Frames are at most 32 KB; a stream with no blank line for this long is not watched further.
      if (buffer.length > MAX_PENDING_CHARS) buffer = '';
      return frames;
    },
  };
};
