// A small promise wrapper over node:http and node:https, shared by the upstreams, the S3 store
// and the credential provider. It never logs bodies or headers.

import http, { type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import https from 'node:https';

export interface OutgoingRequest {
  url: URL;
  method: 'GET' | 'POST';
  headers: OutgoingHttpHeaders;
  body?: Buffer;
  signal?: AbortSignal;
  /** Time allowed until the response headers arrive; the request is destroyed after it. */
  headersTimeoutMs?: number;
}

export class RequestTimeoutError extends Error {
  constructor(message = 'No response headers in time') {
    super(message);
    this.name = 'RequestTimeoutError';
  }
}

export class RequestAbortedError extends Error {
  constructor(message = 'The request was aborted') {
    super(message);
    this.name = 'RequestAbortedError';
  }
}

/** Resolves with the response once its headers arrive; the body is left to the caller to read. */
export const sendRequest = ({ url, method, headers, body, signal, headersTimeoutMs }: OutgoingRequest) =>
  new Promise<IncomingMessage>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RequestAbortedError());
      return;
    }
    const transport = url.protocol === 'https:' ? https : http;
    const outgoing: OutgoingHttpHeaders = { ...headers };
    if (body !== undefined) outgoing['Content-Length'] = String(body.length);
    const req = transport.request(url, { method, headers: outgoing });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      finish(() => reject(new RequestAbortedError()));
      req.destroy();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (headersTimeoutMs !== undefined) {
      timer = setTimeout(() => {
        finish(() => reject(new RequestTimeoutError()));
        req.destroy();
      }, headersTimeoutMs);
    }
    req.on('response', (response) => {
      if (settled) {
        response.destroy();
        return;
      }
      finish(() => resolve(response));
      // An abort after the headers ends the body stream too.
      if (signal) {
        const abortBody = () => response.destroy(new RequestAbortedError());
        if (signal.aborted) abortBody();
        else {
          signal.addEventListener('abort', abortBody, { once: true });
          response.once('close', () => signal.removeEventListener('abort', abortBody));
        }
      }
    });
    req.on('error', (err) => finish(() => reject(err)));
    req.end(body);
  });

export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`The body is larger than ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Reads a whole body up to `limit` bytes. A larger body rejects at once; the stream is destroyed,
 * or, with `discardOverflow` (an incoming request we still answer), drained and dropped.
 */
export const readBody = (
  stream: NodeJS.ReadableStream & { destroy(error?: Error): unknown },
  limit: number,
  { discardOverflow = false }: { discardOverflow?: boolean } = {},
) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    stream.on('data', (chunk: Buffer | string) => {
      if (done) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        if (discardOverflow) stream.resume();
        else stream.destroy();
        reject(new BodyTooLargeError(limit));
        return;
      }
      chunks.push(buf);
    });
    stream.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', (err: Error) => {
      if (done) return;
      done = true;
      reject(err);
    });
    stream.on('close', () => {
      if (done) return;
      done = true;
      reject(new RequestAbortedError('The stream closed before it ended'));
    });
  });

/** Reads at most `limit` bytes of an error body for a log line, and never rejects. */
export const readSnippet = async (response: IncomingMessage, limit = 2048): Promise<string> => {
  try {
    const buf = await readBody(response, 256 * 1024);
    return buf.subarray(0, limit).toString('utf8');
  } catch {
    return '';
  }
};
