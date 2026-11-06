import { AGUI_EVENT_TYPES, type AguiEvent } from './types';

export type SseErrorCode = 'MALFORMED_JSON' | 'NOT_AN_EVENT' | 'UNKNOWN_EVENT';

export interface SseParseError {
  code: SseErrorCode;
  message: string;
  /** The frame's data, truncated, for diagnostics. */
  data: string;
}

export type ParseResult =
  | { kind: 'event'; event: AguiEvent }
  | { kind: 'error'; error: SseParseError };

export interface SseParser {
  /** Feeds one chunk; returns every frame the chunk completed, in order. */
  push(chunk: Uint8Array | string): ParseResult[];
}

const KNOWN_TYPES: ReadonlySet<string> = new Set(AGUI_EVENT_TYPES);
const MAX_ERROR_DATA = 200;

const parseError = (code: SseErrorCode, message: string, data: string): ParseResult => ({
  kind: 'error',
  error: { code, message, data: data.slice(0, MAX_ERROR_DATA) },
});

export const decodeFrameData = (data: string): ParseResult => {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (err) {
    return parseError(
      'MALFORMED_JSON',
      err instanceof Error ? err.message : 'Invalid JSON',
      data,
    );
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { type?: unknown }).type !== 'string'
  ) {
    return parseError('NOT_AN_EVENT', 'Frame is not an object with a type', data);
  }
  const type = (value as { type: string }).type;
  if (!KNOWN_TYPES.has(type)) {
    return parseError('UNKNOWN_EVENT', `Unknown event type ${type}`, data);
  }
  return { kind: 'event', event: value as AguiEvent };
};

/**
 * Incremental text/event-stream reader (WHATWG SSE framing). Only `data:` fields
 * matter; `event:`, `id:`, `retry:` and `:` comments are skipped. A frame that has
 * not seen its blank line yet stays buffered, so a truncated stream yields nothing
 * for its last frame.
 */
export const createSseParser = (): SseParser => {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  // A chunk ending in CR may be the first half of CRLF.
  let skipLeadingLf = false;
  let dataLines: string[] = [];

  const takeLine = (line: string, out: ParseResult[]): void => {
    if (line === '') {
      if (dataLines.length > 0) out.push(decodeFrameData(dataLines.join('\n')));
      dataLines = [];
      return;
    }
    if (line.charCodeAt(0) === 0x3a /* ':' */) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field !== 'data') return;
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 0x20 /* ' ' */) value = value.slice(1);
    dataLines.push(value);
  };

  return {
    push(chunk) {
      const text =
        typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      // The carried-over buffer never holds a line break, so scan only new text.
      const scanFrom = buffer.length;
      buffer += text;
      const out: ParseResult[] = [];
      let start = 0;
      if (skipLeadingLf && buffer.length > 0) {
        if (buffer.charCodeAt(0) === 0x0a) start = 1;
        skipLeadingLf = false;
      }
      for (let i = Math.max(start, scanFrom); i < buffer.length; i++) {
        const c = buffer.charCodeAt(i);
        if (c !== 0x0a && c !== 0x0d) continue;
        takeLine(buffer.slice(start, i), out);
        if (c === 0x0d) {
          if (i + 1 === buffer.length) {
            skipLeadingLf = true;
          } else if (buffer.charCodeAt(i + 1) === 0x0a) {
            i++;
          }
        }
        start = i + 1;
      }
      buffer = buffer.slice(start);
      return out;
    },
  };
};
