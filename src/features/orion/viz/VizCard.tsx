import React, {
  type CSSProperties,
  JSX,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '@mantine/core';
import { LuDatabase, LuShieldAlert, LuShieldCheck, LuShieldQuestion } from 'react-icons/lu';
import type { AppId, PinnedViz, RunView, VizReport, VizSpec } from '../agui/types';
import { formatDuration } from '../format';
import { FrozenTableView } from './FrozenTableView';
import { appTitle, deInputFallback, handoffFor } from '../handoff/handoff';
import { OrionPpCard, type ViewerOutcome } from './OrionPpCard';
import {
  CHECKING,
  checkParity,
  citedStepLabel,
  type Parity,
  parityDetail,
  parityText,
  pinnedHashVerified,
  unchecked,
} from './parity';
import { deriveRequestPinned } from './requestPinned';
import type { ViewerRequest } from './viewerRequests';
import { callOrigin } from '../calls';
import { type CitedCall, VizServicesContext } from './vizServices';

/** viz.de.caption: the p-value table sorts by fold change and pinned state cannot change it (Open question 9). */
export const DE_SORT_CAPTION = 'Table sorted by fold change. Sort by adjusted p-value to match the answer.';
/** viz.de_input.caption: the DEinput fallback stops at the method choice. */
export const DE_INPUT_CAPTION =
  'Choose Wilcoxon and click Run to draw the chart. Table sorted by fold change; sort by adjusted p-value to match the answer.';

/** F2 "Accessibility and layout": below this width a card shows its summary, not the live chart. */
export const MIN_LIVE_WIDTH_PX = 720;

/** The newest requests a card lists. */
const REQUESTS_SHOWN = 50;

/** An expanded card keeps this much space to each side of the area it widens into. */
const EXPAND_GUTTER_PX = 16;

/**
 * The React key a host gives each VizCard. A card reads its spec once, so a new run or viz id
 * must be a new card.
 */
export const vizCardKey = (runId: string, vizId: string): string => `${runId}:${vizId}`;

export interface VizCardProps {
  threadId: string;
  run: RunView;
  spec: VizSpec;
  onReport: (report: VizReport) => void;
  onOpenInTool: (appId: AppId, cohortId: string | null) => void;
  loadUntrimmedSpec: (runId: string, vizId: string) => Promise<VizSpec | null>;
  /** Opens a frozen table chip's fact in the Evidence Inspector. */
  onCite?: (factId: string) => void;
}

/** Which viewer the card mounts: its own launcher, the client's DEinput fallback, or none (cut 2). */
type Stage =
  | { kind: 'primary' }
  | { kind: 'deInput'; pinned: PinnedViz; directError: string }
  | { kind: 'static'; reason: string };

type Inputs = { state: 'ready'; pinned: PinnedViz } | { state: 'loading' } | { state: 'failed'; message: string };

type FingerprintCheck =
  | { state: 'notNeeded' }
  | { state: 'checking' }
  | { state: 'match'; local: string }
  | { state: 'mismatch'; local: string; run: string }
  | { state: 'failed'; message: string };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const shortHash = (hash: string): string => `${hash.slice(0, 8)}…`;

/** Whether the card is too narrow for a live chart; unknown widths (no ResizeObserver) count as wide. */
const useNarrow = (ref: React.RefObject<HTMLElement | null>): boolean => {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width ?? 0;
      setNarrow(width > 0 && width < MIN_LIVE_WIDTH_PX);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
};

const CLIPPING = new Set(['auto', 'scroll', 'hidden', 'clip']);

/** The nearest ancestor that clips its content (a scroll container), or null for the viewport. */
const clippingAncestor = (element: HTMLElement): HTMLElement | null => {
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    if (CLIPPING.has(getComputedStyle(node).overflowX)) return node;
  }
  return null;
};

/**
 * Expand widens the card in place (F3 "How hand-off works": no modal, which would hide
 * ProteinPaint's menus): it stays in the thread's flow but spans the scroll area it sits in.
 */
const useExpandedStyle = (expanded: boolean, ref: React.RefObject<HTMLElement | null>): CSSProperties | undefined => {
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  useEffect(() => {
    const element = ref.current;
    if (!expanded || !element?.parentElement) {
      setStyle(undefined);
      return undefined;
    }
    const place = () => {
      const column = element.parentElement?.getBoundingClientRect();
      const area = clippingAncestor(element)?.getBoundingClientRect() ?? {
        left: 0,
        width: document.documentElement.clientWidth,
      };
      const width = area.width - 2 * EXPAND_GUTTER_PX;
      if (!column || width <= 0 || width <= column.width) {
        setStyle(undefined);
        return;
      }
      setStyle({ marginLeft: area.left + EXPAND_GUTTER_PX - column.left, width, maxWidth: 'none' });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [expanded, ref]);
  return style;
};

const ParityBadge = ({ parity, cited }: { parity: Parity; cited: string }) => {
  const Icon =
    parity.state === 'match' ? LuShieldCheck : parity.state === 'checking' || parity.state === 'unchecked' ? LuShieldQuestion : LuShieldAlert;
  const detail = parityDetail(parity, cited);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-base-light px-2 py-px"
      data-testid="orion-viz-parity"
      data-parity={parity.state}
      title={parity.recomputed ? `${detail} Pinned hash ${parity.recomputed}.` : detail}
    >
      <Icon aria-hidden focusable="false" />
      <span>{parityText(parity, cited)}</span>
      <span className="sr-only">{detail}</span>
      {parity.recomputed && <span className="font-mono">{parity.recomputed.slice(0, 12)}</span>}
    </span>
  );
};

const FINGERPRINT_TEXT: Record<FingerprintCheck['state'], string> = {
  notNeeded: '',
  checking: 'Local data: checking',
  match: 'Local data: matches the run',
  mismatch: 'Local data: differs from the run',
  failed: 'Local data: not checked',
};

const FingerprintBadge = ({ check }: { check: FingerprintCheck }) =>
  check.state === 'notNeeded' ? null : (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-base-light px-2 py-px"
      data-testid="orion-viz-fingerprint"
      data-fingerprint={check.state}
    >
      <LuDatabase aria-hidden focusable="false" />
      <span>{FINGERPRINT_TEXT[check.state]}</span>
    </span>
  );

const requestCache = (request: ViewerRequest, citedCacheId: string | null | undefined, cited: string): string => {
  if (request.error !== null) return `failed: ${request.error}`;
  if (request.cacheId === null) return 'network';
  if (citedCacheId === undefined || citedCacheId === null) return `server cache key ${shortHash(request.cacheId)}`;
  return request.cacheId === citedCacheId
    ? `server cache: same entry as ${cited}`
    : `server cache: not the entry ${cited} used`;
};

const ViewerRequests = ({
  requests,
  citedCacheId,
  cited,
}: {
  requests: readonly ViewerRequest[];
  citedCacheId: string | null | undefined;
  cited: string;
}) => (
  <details className="text-xs" data-testid="orion-viz-requests">
    <summary className="cursor-pointer">Viewer requests ({requests.length})</summary>
    {requests.length > 0 ? (
      <ul className="mt-1 flex flex-col gap-px font-mono">
        {requests.map((r) => (
          <li key={r.id} data-cache={r.cacheId ?? undefined}>
            {r.method} {r.path} · {r.status ?? 'no response'} · {formatDuration(r.ms)} · {requestCache(r, citedCacheId, cited)}
          </li>
        ))}
      </ul>
    ) : (
      <p className="mt-1">The viewer has made no network request yet.</p>
    )}
    <p className="mt-1">
      Requests ProteinPaint answers from its in-page cache make no network call and are not listed.
    </p>
  </details>
);

/**
 * A run's viz card (F1 "Visualization card"; contract "Viz specs"): the native ProteinPaint viewer
 * pinned to the spec's inputs, its parity badge (C-21), caption, the viewer's requests (C-36),
 * Expand, and "Open with this cohort" (FR-14). A direct DE mount that fails falls back to DEinput
 * on the saved cohorts, then to the cited table (cut 2); Don't save turns both hand-off and the
 * DEinput fallback off (C-16). Reports go to `onReport` when the viewer mounts or fails.
 */
export function VizCard({ threadId, run, spec, onReport, onOpenInTool, loadUntrimmedSpec, onCite }: VizCardProps): JSX.Element {
  const services = useContext(VizServicesContext);
  const [frozenSpec] = useState(spec);
  const [inputs, setInputs] = useState<Inputs>(() =>
    frozenSpec.pinned ? { state: 'ready', pinned: frozenSpec.pinned } : { state: 'loading' },
  );
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [parity, setParity] = useState<Parity>(CHECKING);
  const [stage, setStage] = useState<Stage>({ kind: 'primary' });
  const [fingerprint, setFingerprint] = useState<FingerprintCheck>(() =>
    run.environment.mode === 'H' ? { state: 'checking' } : { state: 'notNeeded' },
  );
  const [event, setEvent] = useState<{ mounted: boolean; error: string | null } | null>(null);
  const [requests, setRequests] = useState<ViewerRequest[]>([]);
  const [citedCacheId, setCitedCacheId] = useState<string | null | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(wrapperRef);
  const expandedStyle = useExpandedStyle(expanded, wrapperRef);
  const latest = useRef({ run, onReport, loadUntrimmedSpec, services, threadId });
  latest.current = { run, onReport, loadUntrimmedSpec, services, threadId };
  const sentReport = useRef<string | null>(null);
  const citedCall = useRef<Promise<CitedCall | null> | null>(null);

  const cited = citedStepLabel(frozenSpec, run.steps);
  const handoff = handoffFor(frozenSpec, inputs.state === 'ready' ? inputs.pinned : null, run, services.activeCohortId);

  /** The cited call from the run record, read at most once per card. */
  const loadCitedCall = useCallback((): Promise<CitedCall | null> => {
    if (!citedCall.current) {
      const { services: s, threadId: thread, run: r } = latest.current;
      citedCall.current = s.loadCitedCall(thread, r.runId, callOrigin(r, frozenSpec.citesSteps[0]));
      citedCall.current.catch(() => {
        citedCall.current = null;
      });
    }
    return citedCall.current;
  }, [frozenSpec]);

  // A snapshot trimmed to fit 32 KB carries no pinned inputs: read them from the view route.
  useEffect(() => {
    if (inputs.state !== 'loading') return undefined;
    let current = true;
    const later = spec.pinned && spec.pinnedHash === frozenSpec.pinnedHash ? spec.pinned : null;
    if (later) {
      setInputs({ state: 'ready', pinned: later });
      return undefined;
    }
    latest.current.loadUntrimmedSpec(latest.current.run.runId, frozenSpec.vizId).then(
      (loaded) => {
        if (!current) return;
        if (loaded && loaded.vizId === frozenSpec.vizId && loaded.pinned && loaded.pinned.kind === frozenSpec.launcher) {
          setInputs({ state: 'ready', pinned: loaded.pinned });
        } else {
          setInputs({ state: 'failed', message: 'the run’s view has no pinned inputs for this card' });
        }
      },
      (error: unknown) => current && setInputs({ state: 'failed', message: messageOf(error) }),
    );
    return () => {
      current = false;
    };
  }, [inputs.state, loadAttempt, spec.pinned, spec.pinnedHash, frozenSpec]);

  useEffect(() => {
    if (inputs.state === 'loading') {
      setParity(CHECKING);
      return undefined;
    }
    if (inputs.state === 'failed') {
      setParity(unchecked(`the pinned inputs could not be loaded (${inputs.message})`));
      setStage({
        kind: 'static',
        reason: `The pinned inputs could not be loaded (${inputs.message}), so the viewer cannot start. Showing the cited output.`,
      });
      setEvent({ mounted: false, error: `Pinned inputs unavailable: ${inputs.message}` });
      return undefined;
    }
    setParity(checkParity(inputs.pinned, frozenSpec));
    return undefined;
  }, [inputs, frozenSpec]);

  // Mode H: the viewers read the local stack, so the card checks it holds the run's data.
  const runFingerprint = run.environment.fingerprintSha256;
  useEffect(() => {
    if (run.environment.mode !== 'H') {
      setFingerprint({ state: 'notNeeded' });
      return undefined;
    }
    let current = true;
    setFingerprint({ state: 'checking' });
    latest.current.services.localFingerprint().then(
      (local) => {
        if (!current) return;
        if (runFingerprint === null) setFingerprint({ state: 'failed', message: 'the run has recorded no fingerprint yet' });
        else if (local === runFingerprint) setFingerprint({ state: 'match', local });
        else setFingerprint({ state: 'mismatch', local, run: runFingerprint });
      },
      (error: unknown) => current && setFingerprint({ state: 'failed', message: messageOf(error) }),
    );
    return () => {
      current = false;
    };
  }, [run.environment.mode, runFingerprint]);

  useEffect(() => {
    if (fingerprint.state === 'mismatch') {
      setEvent({
        mounted: false,
        error: `Frozen in mode H: the local fixture fingerprint ${fingerprint.local} differs from the run's ${fingerprint.run}`,
      });
    } else if (fingerprint.state === 'failed') {
      setEvent({ mounted: false, error: `Frozen in mode H: the local fixture fingerprint was not checked (${fingerprint.message})` });
    }
  }, [fingerprint]);

  // One report per outcome, once the parity check has settled; a repeat of the last is not resent.
  useEffect(() => {
    if (!event || parity.state === 'checking') return;
    const report: VizReport = {
      runId: latest.current.run.runId,
      vizId: frozenSpec.vizId,
      mounted: event.mounted,
      error: event.error,
      pinnedHashVerified: pinnedHashVerified(parity),
    };
    const key = JSON.stringify(report);
    if (sentReport.current === key) return;
    sentReport.current = key;
    latest.current.onReport(report);
  }, [event, parity, frozenSpec]);

  const fallBackFromDirect = useCallback(
    (message: string) => {
      const available = deInputFallback(frozenSpec, latest.current.run);
      const toStatic = (why: string) =>
        setStage({ kind: 'static', reason: `The direct DE viewer failed (${message}); ${why} Showing the cited table.` });
      if (!available.available) {
        toStatic(available.reason);
        return;
      }
      loadCitedCall().then(
        (call) => {
          if (!call) {
            toStatic('the run record has no de_run call to seed the DEinput fallback.');
            return;
          }
          try {
            setStage({ kind: 'deInput', pinned: deriveRequestPinned('deInput', call.request), directError: message });
          } catch (error) {
            toStatic(`the DEinput fallback could not be seeded (${messageOf(error)}).`);
          }
        },
        (error: unknown) => toStatic(`the run record could not be read (${messageOf(error)}).`),
      );
    },
    [frozenSpec, loadCitedCall],
  );

  const onOutcome = useCallback(
    (outcome: ViewerOutcome) => {
      if (stage.kind === 'deInput') {
        const note = `Direct DE viewer failed: ${stage.directError}`;
        if (outcome.kind === 'mounted') {
          setEvent({ mounted: true, error: `${note}; the DEinput fallback mounted` });
        } else {
          setEvent({ mounted: false, error: `${note}; the DEinput fallback failed: ${outcome.message}` });
          setStage({
            kind: 'static',
            reason: `The direct DE viewer and the DEinput fallback both failed (${outcome.message}). Showing the cited table.`,
          });
        }
        return;
      }
      if (outcome.kind === 'mounted') {
        setEvent({ mounted: true, error: null });
        return;
      }
      setEvent({ mounted: false, error: outcome.message });
      if (frozenSpec.launcher === 'deDirect') fallBackFromDirect(outcome.message);
      else setStage({ kind: 'static', reason: `The viewer failed (${outcome.message}). Showing the cited output.` });
    },
    [stage, frozenSpec, fallBackFromDirect],
  );

  const onRequest = useCallback(
    (request: ViewerRequest) => {
      setRequests((list) => [...list, request].slice(-REQUESTS_SHOWN));
      if (request.cacheId !== null) {
        loadCitedCall().then(
          (call) => {
            const observed = call?.observed;
            const id =
              observed && typeof observed === 'object' && !Array.isArray(observed) ? observed.cacheId : undefined;
            setCitedCacheId(typeof id === 'string' ? id : null);
          },
          () => setCitedCacheId(null),
        );
      }
    },
    [loadCitedCall],
  );

  const retry = () => {
    sentReport.current = null;
    setEvent(null);
    setStage({ kind: 'primary' });
    if (inputs.state === 'failed') {
      setInputs({ state: 'loading' });
      setLoadAttempt((n) => n + 1);
    }
  };

  const frozenTable = (
    <FrozenTableView frozen={frozenSpec.frozen} facts={run.facts} label={frozenSpec.title} onCite={onCite} />
  );
  const caption =
    stage.kind === 'deInput'
      ? DE_INPUT_CAPTION
      : (frozenSpec.caption ?? (frozenSpec.launcher === 'deDirect' ? DE_SORT_CAPTION : null));

  let blockedReason: string | null = null;
  let blockedView: ReactNode = frozenTable;
  if (stage.kind === 'static') {
    blockedReason = stage.reason;
  } else if (fingerprint.state === 'checking') {
    blockedReason = 'Checking that the local data matches this run before the viewer starts.';
  } else if (fingerprint.state === 'mismatch') {
    blockedReason = `Frozen: the local data differs from the data this run used (fingerprint ${shortHash(fingerprint.local)} here, ${shortHash(fingerprint.run)} in the run), so the chart would not show the cited result.`;
  } else if (fingerprint.state === 'failed') {
    blockedReason = `Frozen: the local data could not be checked against this run (${fingerprint.message}).`;
  } else if (inputs.state !== 'ready') {
    blockedReason = 'Loading the pinned inputs from the run.';
    blockedView = (
      <>
        {caption && <p className="text-sm">{caption}</p>}
        {frozenTable}
      </>
    );
  } else if (narrow) {
    blockedReason = `The live chart needs a card at least ${MIN_LIVE_WIDTH_PX} px wide; showing the cited output. Expand the card or open the full tool.`;
  }

  const mountPinned = stage.kind === 'deInput' ? stage.pinned : inputs.state === 'ready' ? inputs.pinned : null;
  const handoffReasonId = `orion-viz-handoff-${run.runId}-${frozenSpec.vizId}`;

  return (
    <div
      ref={wrapperRef}
      data-testid={`orion-viz-card-${frozenSpec.vizId}`}
      data-stage={stage.kind}
      data-expanded={expanded}
      className="w-full"
      style={expandedStyle}
    >
      <OrionPpCard
        key={stage.kind}
        vizId={frozenSpec.vizId}
        liveKey={vizCardKey(run.runId, frozenSpec.vizId)}
        title={frozenSpec.title}
        subtitle={
          <p className="text-xs" data-testid="orion-viz-pinned-to">
            Pinned to {handoff.cohortNames.length > 0 ? handoff.cohortNames.join(' and ') : 'the run’s cohort'}
            {' · cites '}
            {frozenSpec.citesSteps.join(', ')}
          </p>
        }
        pinned={mountPinned}
        caption={caption}
        host={services.host}
        mountTimeoutMs={services.mountTimeoutMs}
        blockedReason={blockedReason}
        blockedView={blockedView}
        frozenView={frozenTable}
        badge={
          <>
            <ParityBadge parity={parity} cited={cited} />
            <FingerprintBadge check={fingerprint} />
          </>
        }
        onOutcome={onOutcome}
        onRequest={onRequest}
        actions={
          <>
            <Button
              type="button"
              size="xs"
              variant="outline"
              aria-pressed={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'Collapse' : 'Expand'}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={handoff.disabledReason !== null}
              aria-describedby={handoff.disabledReason ? handoffReasonId : undefined}
              onClick={() => onOpenInTool(handoff.appId, handoff.cohortId)}
            >
              {handoff.label}
            </Button>
            {handoff.disabledReason && (
              <span id={handoffReasonId} className="text-xs" data-testid="orion-viz-handoff-reason">
                {handoff.disabledReason}
              </span>
            )}
            {stage.kind === 'static' && (
              <Button type="button" size="xs" variant="subtle" onClick={retry}>
                Try the live viewer again
              </Button>
            )}
          </>
        }
      >
        {stage.kind === 'deInput' && (
          <p role="status" className="text-sm" data-testid="orion-viz-fallback">
            Showing the DEinput fallback: the direct DE viewer failed ({stage.directError}).
          </p>
        )}
        {handoff.settings.length > 0 && handoff.disabledReason === null && (
          <div className="text-xs" data-testid="orion-viz-settings">
            <p>In {appTitle(handoff.appId)}, set these to match this chart:</p>
            <ul className="list-disc pl-5">
              {handoff.settings.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
        <ViewerRequests requests={requests} citedCacheId={citedCacheId} cited={cited} />
      </OrionPpCard>
    </div>
  );
}
