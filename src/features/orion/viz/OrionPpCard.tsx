import React, {
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Button } from '@mantine/core';
import { PROTEINPAINT_API } from '@/core/constants';
import type { PinnedViz } from '../agui/types';
import { Card } from '../cards/Card';
import { formatDuration } from '../format';
import { openMenuScope } from './bodyMenus';
import { LiveVizContext } from './liveViz';
import { buildLauncherArgs, type LauncherArgs, pinnedHash } from './ppPinnedArgs';
import { openViewerTap, type ViewerRequest } from './viewerRequests';

/** What a card uses of a launcher's API: only OncoMatrix's has destroy() in 2.216.0. */
interface PpAppApi {
  triggerAbort?: (reason?: string) => void;
  destroy?: () => void;
}

/** rx component callbacks (`<event>.<namespace>`), as `opts.matrix.callbacks` takes them. */
type RxCallbacks = Record<string, (() => void) | null>;

type RenderOpts = { opts?: { matrix?: { callbacks: RxCallbacks } } };

type InitArgs = LauncherArgs & RenderOpts & { holder: HTMLElement };

/** The package ships no types (`declare module` only), so the call is typed here. */
type BindProteinPaint = (arg: { rootElem: HTMLElement; initArgs: InitArgs }) => Promise<PpAppApi | undefined>;

/** A viewer that has not drawn by then counts as failed (the A4 step timeout). */
export const MOUNT_TIMEOUT_MS = 60_000;

/** ProteinPaint's sayerror() bar, which runproteinpaint and the mass apps write into the holder. */
const ERROR_SELECTOR = '.sja_errorbar';

export type VizPhase = 'frozen' | 'blocked' | 'queued' | 'loading' | 'mounted' | 'error';

/** How one live session ended: the viewer drew, or it failed (with ProteinPaint's message). */
export type ViewerOutcome = { kind: 'mounted'; ms: number } | { kind: 'failed'; ms: number; message: string };

interface Session {
  phase: 'queued' | 'loading' | 'mounted' | 'error';
  ms?: number;
  message?: string;
}

export interface OrionPpCardProps {
  vizId: string;
  title: ReactNode;
  /**
   * Read once, when first non-null: the card never follows later props or the live cohort. Null
   * (a trimmed snapshot still loading its inputs) keeps the card blocked.
   */
  pinned: PinnedViz | null;
  caption?: ReactNode;
  /** The first line under the header, such as the cohort the card is pinned to. */
  subtitle?: ReactNode;
  host?: string;
  /** The live-registry key; defaults to vizId. Viz ids are unique within a run only. */
  liveKey?: string;
  /** While set, the card takes no live slot and shows this line and `blockedView`. */
  blockedReason?: string | null;
  /** What a blocked card shows under its reason; defaults to `frozenView`. */
  blockedView?: ReactNode;
  /** What a card frozen by the two-live cap shows above Re-open live (its cited output). */
  frozenView?: ReactNode;
  /** Replaces the header's pinned-hash line, such as with the parity badge. */
  badge?: ReactNode;
  /** The card's action buttons, under the viewer. */
  actions?: ReactNode;
  /** Shown last, such as the viewer's requests. */
  children?: ReactNode;
  className?: string;
  /** Called once per live session, when the viewer has drawn or failed. */
  onOutcome?: (outcome: ViewerOutcome) => void;
  /** Each request the viewer makes while this card owns it (viewerRequests.ts). */
  onRequest?: (request: ViewerRequest) => void;
  mountTimeoutMs?: number;
}

/** Hidden by its own or an ancestor's inline style (up to the holder), as ProteinPaint hides it. */
const isHidden = (element: HTMLElement, root: HTMLElement): boolean => {
  for (let node: HTMLElement | null = element; node && node !== root; node = node.parentElement) {
    if (node.hidden || node.style.display === 'none') return true;
  }
  return false;
};

/**
 * The message of the first error bar ProteinPaint shows in the holder. The mass apps (Correlation
 * Plot, DE, OncoMatrix) create an empty bar hidden with display:none at start, ready for a later
 * error; that bar is not an error until it is shown.
 */
export const errorText = (root: HTMLElement): string | null => {
  for (const bar of root.querySelectorAll<HTMLElement>(ERROR_SELECTOR)) {
    if (isHidden(bar, root)) continue;
    // The bar's first child is its close cross; the message follows.
    const text = bar.lastElementChild?.textContent ?? bar.textContent ?? '';
    return text.trim() || 'The viewer reported an error.';
  }
  return null;
};

/**
 * OncoMatrix's bindProteinPaint promise resolves before the matrix request (spike, "What Day 1
 * PM and Day 2 viz work must know" 3), so its card waits for the matrix component's own
 * postRender or error event. The Correlation and DE launchers resolve after their first render.
 */
const withRenderCallbacks = (args: LauncherArgs, onRendered: () => void, onError: () => void): LauncherArgs & RenderOpts =>
  'launchGdcMatrix' in args
    ? { ...args, opts: { matrix: { callbacks: { 'postRender.orion': onRendered, 'error.orion': onError } } } }
    : args;

/**
 * A native ProteinPaint viewer pinned to a run's inputs. At most two cards hold a live viewer;
 * an older one freezes and tears its viewer down until Re-open live. Viewers start one at a time,
 * so each card can name the requests its viewer made.
 */
export const OrionPpCard = ({
  vizId,
  title,
  pinned,
  caption,
  subtitle,
  host = PROTEINPAINT_API,
  liveKey = vizId,
  blockedReason = null,
  blockedView,
  frozenView,
  badge,
  actions,
  children,
  className,
  onOutcome,
  onRequest,
  mountTimeoutMs = MOUNT_TIMEOUT_MS,
}: OrionPpCardProps) => {
  const titleId = useId();
  const registry = useContext(LiveVizContext);
  const inRegistry = useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot).includes(liveKey);
  const [frozenInputs, setFrozenInputs] = useState(() => (pinned ? { pinned, host } : null));
  const [session, setSession] = useState<Session>({ phase: 'queued' });
  const viewerRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onOutcome, onRequest });
  callbacks.current = { onOutcome, onRequest };

  const blocked = blockedReason !== null || frozenInputs === null;
  const live = inRegistry && !blocked;

  useEffect(() => {
    if (!frozenInputs && pinned) setFrozenInputs({ pinned, host });
  }, [frozenInputs, pinned, host]);

  useEffect(() => {
    if (blocked) return undefined;
    registry.activate(liveKey);
    return () => registry.release(liveKey);
  }, [registry, liveKey, blocked]);

  const hash = useMemo(() => {
    if (!frozenInputs) return null;
    try {
      return pinnedHash(frozenInputs.pinned);
    } catch {
      // A number outside the portable range: the header shows no hash.
      return null;
    }
  }, [frozenInputs]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!live || !viewer || !frozenInputs) return undefined;
    // bindProteinPaint keys its instances by rootElem and never unbinds, so every live
    // session needs a fresh element.
    const rootElem = document.createElement('div');
    viewer.appendChild(rootElem);
    const tap = openViewerTap(frozenInputs.host, () => viewerRef.current, (r) => callbacks.current.onRequest?.(r));
    let disposed = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = 0;
    let menus: ReturnType<typeof openMenuScope> | null = null;
    setSession({ phase: 'queued' });

    const settle = (outcome: { kind: 'mounted' } | { kind: 'failed'; message: string }) => {
      if (settled || disposed) return;
      settled = true;
      clearTimeout(timer);
      tap.mountDone();
      const ms = performance.now() - started;
      setSession(outcome.kind === 'mounted' ? { phase: 'mounted', ms } : { phase: 'error', ms, message: outcome.message });
      callbacks.current.onOutcome?.(outcome.kind === 'mounted' ? { kind: 'mounted', ms } : { ...outcome, ms });
    };
    const rendered = () => {
      const message = errorText(rootElem);
      settle(message ? { kind: 'failed', message } : { kind: 'mounted' });
    };
    const failedRender = () => settle({ kind: 'failed', message: errorText(rootElem) ?? 'The viewer reported an error.' });
    const launcherArgs = withRenderCallbacks(buildLauncherArgs(frozenInputs.pinned, frozenInputs.host), rendered, failedRender);
    const waitsForRender = 'opts' in launcherArgs;

    const app: Promise<PpAppApi | undefined> = tap.mountTurn().then(async () => {
      if (disposed) return undefined;
      setSession({ phase: 'loading' });
      menus = openMenuScope();
      started = performance.now();
      timer = setTimeout(
        () => settle({ kind: 'failed', message: `The viewer did not finish drawing within ${formatDuration(mountTimeoutMs)}.` }),
        mountTimeoutMs,
      );
      const { bindProteinPaint } = (await import('@sjcrh/proteinpaint-client')) as { bindProteinPaint: BindProteinPaint };
      if (disposed) return undefined;
      return bindProteinPaint({ rootElem, initArgs: { ...launcherArgs, holder: rootElem } });
    });
    app.then(
      (api) => {
        if (disposed) return;
        // runproteinpaint catches its own errors and writes them into the holder.
        if (!api) settle({ kind: 'failed', message: errorText(rootElem) ?? (rootElem.textContent || 'The viewer did not start.') });
        else if (errorText(rootElem)) failedRender();
        else if (!waitsForRender) settle({ kind: 'mounted' });
      },
      (error: unknown) => settle({ kind: 'failed', message: error instanceof Error ? error.message : String(error) }),
    );

    return () => {
      disposed = true;
      clearTimeout(timer);
      tap.close();
      rootElem.remove();
      // A viewer still starting keeps adding menus; release them once it settles.
      void app
        .catch(() => undefined)
        .then((api) => {
          api?.triggerAbort?.('ORION card closed');
          api?.destroy?.();
          rootElem.replaceChildren();
          menus?.release();
        });
    };
  }, [live, frozenInputs, mountTimeoutMs]);

  const phase: VizPhase = blocked ? 'blocked' : live ? session.phase : 'frozen';
  const statusText = {
    blocked: 'Not live',
    frozen: 'Frozen',
    queued: 'Waiting to start',
    loading: 'Loading viewer',
    mounted: `Live${session.ms === undefined ? '' : ` · ready in ${formatDuration(session.ms)}`}`,
    error: 'Viewer failed',
  }[phase];

  return (
    <Card
      titleId={titleId}
      title={title}
      className={className}
      status={
        <span className="flex flex-wrap items-center gap-2 text-xs" data-testid="orion-viz-status">
          <span>{statusText}</span>
          {badge ??
            (hash && (
              <span>
                {'pinned '}
                <span className="font-mono" title={hash}>
                  {hash.slice(0, 12)}
                </span>
              </span>
            ))}
        </span>
      }
      data-orion-viz
    >
      <div
        data-testid={`orion-viz-${vizId}`}
        data-viz-id={vizId}
        data-phase={phase}
        data-mount-ms={session.ms === undefined || !live ? undefined : Math.round(session.ms)}
        data-pinned-hash={hash ?? undefined}
        className="flex flex-col gap-2"
      >
        {subtitle}
        {phase === 'error' && session.message && (
          <p role="alert" className="text-sm">
            {session.message}
          </p>
        )}
        {live ? (
          <>
            <div ref={viewerRef} className="min-h-[120px] overflow-x-auto bg-white" />
            {caption && <p className="text-sm">{caption}</p>}
            {/* NFR-09 (A4): the chart's cited values as a text table beside it, chips included. */}
            {frozenView && (
              <details className="text-sm" data-testid="orion-viz-data-table">
                <summary className="cursor-pointer font-medium">Data table</summary>
                <div className="pt-2">{frozenView}</div>
              </details>
            )}
          </>
        ) : blocked ? (
          <>
            {blockedReason && (
              <p role="status" className="text-sm">
                {blockedReason}
              </p>
            )}
            {blockedView ?? frozenView}
          </>
        ) : (
          <>
            {frozenView}
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span>Frozen so that at most two viewers stay live on this page.</span>
              <Button type="button" size="xs" variant="outline" onClick={() => registry.activate(liveKey)}>
                Re-open live
              </Button>
            </div>
          </>
        )}
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        {children}
      </div>
    </Card>
  );
};
