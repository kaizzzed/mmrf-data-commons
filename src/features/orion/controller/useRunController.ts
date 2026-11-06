import { useEffect, useMemo, useState, type Dispatch } from 'react';
import type { RunTransport } from '../agui/transport';
import type { TabAction } from '../state/tab';
import { createRunController, type RunController } from './runController';

export type { AskOptions, ResumeAction, ResumeExpectation, RunController } from './runController';

/**
 * The tab's run controller for one transport (see createRunController). It is disposed, streams
 * aborted and timers cleared, when the transport changes or the Assistant unmounts.
 */
export const useRunController = (
  transport: RunTransport,
  dispatch: Dispatch<TabAction>,
): RunController => {
  const controller = useMemo(() => createRunController(transport, dispatch), [transport, dispatch]);
  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);
  return controller;
};

/**
 * The controller's busyThreads(), as state. Its changes render as ordinary updates, batched with
 * the dispatches around them (a store subscription would force a render of its own each time); a
 * click that acts on it reads controller.busyThreads() itself.
 */
export const useBusyThreads = (controller: RunController): ReadonlySet<string> => {
  const [busy, setBusy] = useState(() => controller.busyThreads());
  useEffect(() => {
    setBusy(controller.busyThreads());
    return controller.subscribe(() => setBusy(controller.busyThreads()));
  }, [controller]);
  return busy;
};
