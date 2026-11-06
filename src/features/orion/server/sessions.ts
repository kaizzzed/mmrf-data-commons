// The BFF's only state: each thread's open upstream call (one in flight per Runtime session, C-18).
// Stop, an edit or a confirm aborts the open call first; any other turn is refused as busy.

import type { OrionActionName } from '../agui/types';
import { PREEMPTING_ACTIONS } from './runInput';

export interface OpenCall {
  readonly seq: number;
  readonly threadId: string;
  readonly runId: string;
  readonly action: OrionActionName;
  /** Aborts this call's upstream request. */
  readonly controller: AbortController;
  /** Resolves once this call's upstream request has closed, or was never sent. */
  readonly closed: Promise<void>;
  markClosed(): void;
}

export interface Claim {
  call: OpenCall;
  /** The call this turn aborted; wait for it to close before sending. */
  preempted: OpenCall | null;
}

export class SessionRegistry {
  private readonly calls = new Map<string, OpenCall>();
  private seq = 0;

  current(threadId: string): OpenCall | undefined {
    return this.calls.get(threadId);
  }

  get size(): number {
    return this.calls.size;
  }

  /**
   * Claims the thread's session for a turn, synchronously so two turns cannot both pass. Null when
   * a call is open and the action does not preempt it (the route answers SESSION_BUSY).
   */
  claim(threadId: string, runId: string, action: OrionActionName): Claim | null {
    const open = this.calls.get(threadId);
    if (open && !PREEMPTING_ACTIONS.has(action)) return null;
    let markClosed = (): void => undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const call: OpenCall = {
      seq: ++this.seq,
      threadId,
      runId,
      action,
      controller: new AbortController(),
      closed,
      markClosed: () => markClosed(),
    };
    this.calls.set(threadId, call);
    if (open) open.controller.abort(new Error(`preempted by ${action}`));
    return { call, preempted: open ?? null };
  }

  /** Frees the session if this call still holds it, and marks the call closed. */
  release(call: OpenCall): void {
    if (this.calls.get(call.threadId) === call) this.calls.delete(call.threadId);
    call.markClosed();
  }
}

const KEY = Symbol.for('orion.bff.sessions');

/** One registry per server process, kept across dev-mode module reloads. */
export const sharedSessions = (): SessionRegistry => {
  const holder = globalThis as typeof globalThis & { [KEY]?: SessionRegistry };
  holder[KEY] ??= new SessionRegistry();
  return holder[KEY];
};
