import { createSseParser, type ParseResult } from './sseParser';
import { readFixtureBytes } from '../testing';

const parseAll = (...chunks: (Uint8Array | string)[]): ParseResult[] => {
  const parser = createSseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
};

const events = (results: ParseResult[]) =>
  results.map((r) => (r.kind === 'event' ? r.event.type : `error:${r.error.code}`));

const STARTED = '{"type":"RUN_STARTED","threadId":"t","runId":"r"}';

describe('createSseParser', () => {
  const bytes = readFixtureBytes();
  const baseline = parseAll(bytes);
  const baselineJson = JSON.stringify(baseline);

  it('reads the J1 reference stream as 22 events ending in RUN_FINISHED', () => {
    expect(baseline).toHaveLength(22);
    expect(baseline.every((r) => r.kind === 'event')).toBe(true);
    expect(events(baseline)[0]).toBe('RUN_STARTED');
    expect(events(baseline).at(-1)).toBe('RUN_FINISHED');
  });

  it('yields identical events when the stream splits at any byte offset', () => {
    // The fixture holds multi-byte characters (– and …), so some splits land inside one.
    expect(bytes.length).toBeGreaterThan(new TextDecoder().decode(bytes).length);
    const mismatches: number[] = [];
    for (let offset = 0; offset <= bytes.length; offset++) {
      const result = parseAll(bytes.subarray(0, offset), bytes.subarray(offset));
      if (JSON.stringify(result) !== baselineJson) mismatches.push(offset);
    }
    expect(mismatches).toEqual([]);
  }, 60_000);

  it('yields identical events when fed one byte at a time', () => {
    const parser = createSseParser();
    const result: ParseResult[] = [];
    for (let i = 0; i < bytes.length; i++) result.push(...parser.push(bytes.subarray(i, i + 1)));
    expect(JSON.stringify(result)).toBe(baselineJson);
  });

  it('accepts CRLF line endings, including a CR and LF in different chunks', () => {
    const crlf = new TextDecoder().decode(bytes).replace(/\n/g, '\r\n');
    expect(JSON.stringify(parseAll(crlf))).toBe(baselineJson);
    // Multi-line data: a CRLF read as two line breaks would end the frame early.
    const frame = 'data: {"type":\r\ndata: "RUN_STARTED","threadId":"t","runId":"r"}\r\n\r\n';
    for (let offset = 0; offset <= frame.length; offset++) {
      expect(events(parseAll(frame.slice(0, offset), frame.slice(offset)))).toEqual([
        'RUN_STARTED',
      ]);
    }
  });

  it('skips comments and the event, id and retry fields', () => {
    const stream =
      ': keep-alive\n\n' +
      `event: message\nid: 7\nretry: 1000\n: note\ndata: ${STARTED}\n\n`;
    expect(events(parseAll(stream))).toEqual(['RUN_STARTED']);
  });

  it('joins multi-line data with newlines and accepts data: without a space', () => {
    const stream = 'data:{"type":\ndata: "RUN_STARTED","threadId":"t",\ndata: "runId":"r"}\n\n';
    const [result] = parseAll(stream);
    expect(result).toEqual({
      kind: 'event',
      event: { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
    });
  });

  it('reports malformed JSON as a typed error and keeps reading', () => {
    const results = parseAll(`data: {not json}\n\ndata: ${STARTED}\n\n`);
    expect(events(results)).toEqual(['error:MALFORMED_JSON', 'RUN_STARTED']);
    expect(results[0]).toMatchObject({ kind: 'error', error: { data: '{not json}' } });
  });

  it('reports frames that are not known events', () => {
    const results = parseAll('data: 42\n\ndata: {"type":"RAW"}\n\ndata: {"no":"type"}\n\n');
    expect(events(results)).toEqual([
      'error:NOT_AN_EVENT',
      'error:UNKNOWN_EVENT',
      'error:NOT_AN_EVENT',
    ]);
  });

  it('holds a final partial frame until its blank line arrives', () => {
    const parser = createSseParser();
    expect(parser.push(`data: ${STARTED}`)).toEqual([]);
    expect(parser.push('\n')).toEqual([]);
    expect(events(parser.push('\n'))).toEqual(['RUN_STARTED']);
  });
});
