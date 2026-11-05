// One turn through the BFF (contract "POST /api/orion/agui"): one call per session, Stop, edit and
// confirm aborting the open call, the agent's SSE bytes relayed unchanged and flushed per chunk,
// no disconnect forwarding, and BffError answers only before the stream starts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { clearTimeout, setTimeout } from 'node:timers';
import { SSE_RESPONSE_HEADERS } from '../agui/types';
import { BffFailure, sendBffError } from './errors';
import { createFrameScanner, type SeenFrame } from './frames';
import { RequestAbortedError, readSnippet } from './httpClient';
import { log } from './log';
import { isEventStream } from './routes';
import type { Turn } from './runInput';
import type { OpenCall, SessionRegistry } from './sessions';
import { UpstreamSetupError, type Upstream } from './upstream';

export interface RelayTimers {
  /** Contract: no first byte within 30 s is UPSTREAM_TIMEOUT. */
  firstByteMs: number;
  /** After the stream started: the agent heartbeats every 15 s, so this long in silence means it is gone. */
  idleMs: number;
  /** Contract (C-18): StopRuntimeSession when no Cancelled snapshot arrives within 10 s of a cancel. */
  stopGraceMs: number;
  /** How long a preempting turn waits for the aborted call's connection to close. */
  preemptWaitMs: number;
}

export const DEFAULT_TIMERS: RelayTimers = {
  firstByteMs: 30_000,
  idleMs: 60_000,
  stopGraceMs: 10_000,
  preemptWaitMs: 5_000,
};

export interface RelayDeps {
  upstream: Upstream;
  sessions: SessionRegistry;
  timers: RelayTimers;
}

const NETWORK_ERRORS: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
]);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });

const statusFailure = (status: number): BffFailure => {
  if (status === 409) return new BffFailure('SESSION_BUSY', 'The agent session is busy with another call.');
  if (status === 429 || status === 503) return new BffFailure('UPSTREAM_UNAVAILABLE', 'ORION is unavailable right now.');
  return new BffFailure('UPSTREAM_ERROR', `The agent answered HTTP ${status}.`);
};

/**
 * Arms the Stop grace for a cancel (modes A and H): unless a snapshot of the target run with
 * status Cancelled (or its RUN_FINISHED Cancelled) passes in time, call StopRuntimeSession. A
 * newer call holding the session by then is left alone. Returns the frame observer.
 */
const armStopGrace = (turn: Turn, call: OpenCall, deps: RelayDeps): ((frame: SeenFrame) => void) => {
  let confirmed = false;
  const timer = setTimeout(() => {
    if (confirmed) return;
    const holder = deps.sessions.current(turn.threadId);
    if (holder && holder !== call) {
      log('info', 'stop_session_skipped', { threadId: turn.threadId, runId: turn.runId, reason: 'newer call' });
      return;
    }
    const stop = deps.upstream.stopSession;
    if (!stop) return;
    void stop(turn.threadId).then((outcome) =>
      log(outcome.ok ? 'info' : 'warn', 'stop_session', {
        threadId: turn.threadId,
        runId: turn.runId,
        ok: outcome.ok,
        status: outcome.status,
        reason: outcome.ok ? undefined : outcome.reason,
      }),
    );
  }, deps.timers.stopGraceMs);
  timer.unref();
  return (frame) => {
    if (confirmed) return;
    const cancelled =
      (frame.type === 'STATE_SNAPSHOT' && frame.runId === turn.runId && frame.status === 'Cancelled') ||
      (frame.type === 'RUN_FINISHED' && frame.runId === turn.runId && frame.status === 'Cancelled');
    if (cancelled) {
      confirmed = true;
      clearTimeout(timer);
    }
  };
};

/**
 * Relays one turn. Resolves when the browser's response is done; the upstream call may go on
 * after that (a disconnect is not forwarded) and frees the session when it ends. Throws
 * BffFailure only before anything was sent, so the route can answer with a BffError.
 */
export const relayTurn = async (
  res: ServerResponse,
  turn: Turn,
  traceparent: string | null,
  deps: RelayDeps,
): Promise<void> => {
  const claim = deps.sessions.claim(turn.threadId, turn.runId, turn.action);
  if (!claim) throw new BffFailure('SESSION_BUSY', 'Another turn of this thread is still streaming.');
  const { call, preempted } = claim;
  const { threadId, action } = turn;
  let handedOff = false;
  try {
    if (preempted) {
      log('info', 'upstream_aborted', { threadId, runId: preempted.runId, action: preempted.action, by: action });
      await Promise.race([preempted.closed, delay(deps.timers.preemptWaitMs)]);
    }
    if (call.controller.signal.aborted) {
      throw new BffFailure('SESSION_BUSY', 'A newer turn of this thread replaced this one before it was sent.');
    }
    const observe = action === 'cancel' && deps.upstream.stopSession ? armStopGrace(turn, call, deps) : null;
    handedOff = true;
    return await stream(res, turn, traceparent, call, deps, observe);
  } finally {
    if (!handedOff) deps.sessions.release(call);
  }
};

const stream = (
  res: ServerResponse,
  turn: Turn,
  traceparent: string | null,
  call: OpenCall,
  deps: RelayDeps,
  observe: ((frame: SeenFrame) => void) | null,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const { threadId, runId, action } = turn;
    const local = new AbortController();
    const signal = AbortSignal.any([call.controller.signal, local.signal]);
    const scanner = createFrameScanner();
    let started = false;
    let answered = false;
    let clientGone = false;
    let terminal = false;
    let timedOut = false;
    let idled = false;
    let relayed = 0;
    let upstream: IncomingMessage | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    // The browser may have left while this turn waited for a preempted call to close.
    if (res.destroyed) clientGone = true;

    const firstByteTimer = setTimeout(() => {
      timedOut = true;
      local.abort(new Error('no first byte'));
    }, deps.timers.firstByteMs);

    const stopIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    const armIdle = () => {
      stopIdle();
      idleTimer = setTimeout(() => {
        idled = true;
        log('warn', 'upstream_idle', { threadId, runId, action });
        local.abort(new Error('idle'));
      }, deps.timers.idleMs);
    };

    /** Settles the route's promise once: a failure before the stream starts becomes a BffError. */
    const answer = (failure: BffFailure | null) => {
      if (answered) return;
      answered = true;
      if (failure) reject(failure);
      else resolve();
    };

    let closedUpstream = false;
    const upstreamClosed = () => {
      if (closedUpstream) return;
      closedUpstream = true;
      clearTimeout(firstByteTimer);
      stopIdle();
      deps.sessions.release(call);
      log('info', 'turn_ended', {
        threadId,
        runId,
        action,
        started,
        terminal,
        bytes: relayed,
        clientGone,
        aborted: call.controller.signal.aborted,
      });
    };

    const failBeforeStart = (failure: BffFailure) => {
      upstreamClosed();
      answer(failure);
    };

    const preStartFailure = (err: unknown): BffFailure => {
      if (timedOut) return new BffFailure('UPSTREAM_TIMEOUT', 'The agent sent nothing within 30 s.');
      if (call.controller.signal.aborted) {
        return new BffFailure('SESSION_BUSY', 'A newer turn of this thread replaced this one.');
      }
      if (err instanceof UpstreamSetupError) {
        log('error', 'upstream_setup_failed', { threadId, runId, reason: err.message });
        return new BffFailure('UPSTREAM_UNAVAILABLE', 'ORION is unavailable right now.');
      }
      const code = (err as NodeJS.ErrnoException | undefined)?.code ?? '';
      if (NETWORK_ERRORS.has(code)) {
        log('warn', 'upstream_unreachable', { threadId, runId, reason: code });
        return new BffFailure('UPSTREAM_UNAVAILABLE', 'ORION is unavailable right now.');
      }
      log('warn', 'upstream_failed', { threadId, runId, reason: err instanceof Error ? err.name : 'error' });
      return new BffFailure('UPSTREAM_ERROR', 'The agent call failed before it streamed.');
    };

    // The browser leaving never aborts the upstream call: keep reading it to its end.
    res.on('close', () => {
      if (!res.writableFinished) {
        clientGone = true;
        if (upstream?.isPaused()) upstream.resume();
      }
      if (started) answer(null);
    });

    const onData = (chunk: Buffer) => {
      if (!started) {
        started = true;
        clearTimeout(firstByteTimer);
        if (res.destroyed) clientGone = true;
        if (!clientGone) {
          res.writeHead(200, { ...SSE_RESPONSE_HEADERS });
          res.flushHeaders();
          res.socket?.setNoDelay(true);
        }
      }
      relayed += chunk.length;
      for (const frame of scanner.push(chunk)) {
        if (frame.type === 'RUN_FINISHED' || frame.type === 'RUN_ERROR') terminal = true;
        observe?.(frame);
      }
      if (clientGone || res.writableEnded) {
        armIdle();
        return;
      }
      if (res.write(chunk)) {
        armIdle();
      } else {
        // Backpressure: the browser reads slowly. Pause the agent, not the idle clock's cause.
        stopIdle();
        upstream?.pause();
        res.once('drain', () => {
          armIdle();
          upstream?.resume();
        });
      }
    };

    const onEnd = () => {
      upstreamClosed();
      if (!started) {
        answer(new BffFailure('UPSTREAM_ERROR', 'The agent ended the call without a byte.'));
        return;
      }
      if (!clientGone && !res.writableEnded) res.end();
      answer(null);
    };

    /** After the stream started an upstream failure only ends the response; no frame is invented. */
    const onBroken = (err: unknown) => {
      if (closedUpstream) return;
      if (!started) {
        failBeforeStart(preStartFailure(err));
        return;
      }
      upstreamClosed();
      if (idled) log('warn', 'stream_ended_idle', { threadId, runId });
      if (!clientGone && !res.writableEnded) res.end();
      answer(null);
    };

    log('info', 'turn_sent', { threadId, runId, action });
    deps.upstream
      .send({ threadId, body: turn.bytes, traceparent, signal })
      .then(
        async (response) => {
          upstream = response;
          const status = response.statusCode ?? 0;
          if (status < 200 || status > 299) {
            const errorType = String(response.headers['x-amzn-errortype'] ?? '').split(':')[0];
            await readSnippet(response);
            log('warn', 'upstream_status', { threadId, runId, action, status, errorType: errorType || undefined });
            failBeforeStart(statusFailure(status));
            return;
          }
          const type = response.headers['content-type'];
          if (!isEventStream(Array.isArray(type) ? type[0] : type)) {
            await readSnippet(response);
            log('warn', 'upstream_not_stream', { threadId, runId, action, status });
            failBeforeStart(new BffFailure('UPSTREAM_ERROR', 'The agent did not answer with an event stream.'));
            return;
          }
          response.on('data', onData);
          response.on('end', onEnd);
          response.on('error', onBroken);
          response.on('close', () => onBroken(new RequestAbortedError('closed')));
        },
        (err: unknown) => failBeforeStart(preStartFailure(err)),
      )
      .catch((err: unknown) => {
        log('error', 'relay_failed', { threadId, runId, reason: err instanceof Error ? err.name : 'error' });
        failBeforeStart(new BffFailure('UPSTREAM_ERROR', 'The agent call failed before it streamed.'));
      });
  });

/** For the route: answers a relay failure, or ends a response that already started. */
export const answerRelayFailure = (res: ServerResponse, err: unknown): void => {
  if (err instanceof BffFailure) {
    sendBffError(res, err);
    return;
  }
  log('error', 'agui_failed', { reason: err instanceof Error ? err.name : 'error' });
  sendBffError(res, new BffFailure('UPSTREAM_ERROR', 'The turn failed.'));
};
