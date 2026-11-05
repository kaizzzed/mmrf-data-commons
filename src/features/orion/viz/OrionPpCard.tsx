import React, {
  type ReactNode,
  useContext,
  useEffect,
  useId,
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

/** What a card uses of a launcher's API: only OncoMatrix's has destroy() in 2.216.0. */
interface PpAppApi {
  triggerAbort?: (reason?: string) => void;
  destroy?: () => void;
}

/** The package ships no types (`declare module` only), so the call is typed here. */
type BindProteinPaint = (arg: {
  rootElem: HTMLElement;
  initArgs: LauncherArgs & { holder: HTMLElement };
}) => Promise<PpAppApi | undefined>;

export type VizPhase = 'frozen' | 'loading' | 'mounted' | 'error';

interface Session {
  phase: Exclude<VizPhase, 'frozen'>;
  ms?: number;
  message?: string;
}

export interface OrionPpCardProps {
  vizId: string;
  title: string;
  /** Read once, at first render: the card never follows later props or the live cohort. */
  pinned: PinnedViz;
  caption?: ReactNode;
  host?: string;
}

/**
 * A native ProteinPaint viewer pinned to a run's inputs. At most two cards hold a live viewer;
 * an older one freezes and tears its viewer down until Re-open live.
 */
export const OrionPpCard = ({ vizId, title, pinned, caption, host = PROTEINPAINT_API }: OrionPpCardProps) => {
  const titleId = useId();
  const registry = useContext(LiveVizContext);
  const live = useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot).includes(vizId);
  const [frozenInputs] = useState(() => ({ pinned, host }));
  const [hash, setHash] = useState<string | null>(null);
  const [session, setSession] = useState<Session>({ phase: 'loading' });
  const viewerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registry.activate(vizId);
    return () => registry.release(vizId);
  }, [registry, vizId]);

  useEffect(() => {
    let current = true;
    pinnedHash(frozenInputs.pinned).then(
      (value) => current && setHash(value),
      () => current && setHash(null),
    );
    return () => {
      current = false;
    };
  }, [frozenInputs]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!live || !viewer) return;
    // bindProteinPaint keys its instances by rootElem and never unbinds, so every live
    // session needs a fresh element.
    const rootElem = document.createElement('div');
    viewer.appendChild(rootElem);
    const menus = openMenuScope();
    const started = performance.now();
    let disposed = false;
    setSession({ phase: 'loading' });

    const app = import('@sjcrh/proteinpaint-client').then(
      ({ bindProteinPaint }: { bindProteinPaint: BindProteinPaint }) =>
        disposed
          ? undefined
          : bindProteinPaint({
              rootElem,
              initArgs: { ...buildLauncherArgs(frozenInputs.pinned, frozenInputs.host), holder: rootElem },
            }),
    );
    app.then(
      (api) => {
        if (disposed) return;
        // runproteinpaint catches its own errors and writes them into the holder.
        setSession(
          api
            ? { phase: 'mounted', ms: performance.now() - started }
            : { phase: 'error', message: rootElem.textContent || 'The viewer did not start.' },
        );
      },
      (error: unknown) => !disposed && setSession({ phase: 'error', message: String(error) }),
    );

    return () => {
      disposed = true;
      rootElem.remove();
      // A viewer still starting keeps adding menus; release them once it settles.
      void app
        .catch(() => undefined)
        .then((api) => {
          api?.triggerAbort?.('ORION card closed');
          api?.destroy?.();
          rootElem.replaceChildren();
          menus.release();
        });
    };
  }, [live, frozenInputs]);

  const phase: VizPhase = live ? session.phase : 'frozen';
  const statusText = {
    frozen: 'Frozen',
    loading: 'Loading viewer',
    mounted: `Live${session.ms === undefined ? '' : ` · ready in ${formatDuration(session.ms)}`}`,
    error: 'Viewer failed',
  }[phase];

  return (
    <Card
      titleId={titleId}
      title={title}
      status={
        <span className="text-xs" data-testid="orion-viz-status">
          {statusText}
          {hash && (
            <>
              {' · pinned '}
              <span className="font-mono" title={hash}>
                {hash.slice(0, 12)}
              </span>
            </>
          )}
        </span>
      }
      data-orion-viz
    >
      <div
        data-testid={`orion-viz-${vizId}`}
        data-viz-id={vizId}
        data-phase={phase}
        data-mount-ms={session.ms === undefined ? undefined : Math.round(session.ms)}
        data-pinned-hash={hash ?? undefined}
        className="flex flex-col gap-2"
      >
        {caption && <p className="text-sm">{caption}</p>}
        {phase === 'error' && session.message && (
          <p role="alert" className="text-sm">
            {session.message}
          </p>
        )}
        {live ? (
          <div ref={viewerRef} className="min-h-[120px] overflow-x-auto bg-white" />
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>Frozen so that at most two viewers stay live on this page.</span>
            <Button type="button" size="xs" variant="outline" onClick={() => registry.activate(vizId)}>
              Re-open live
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
};
