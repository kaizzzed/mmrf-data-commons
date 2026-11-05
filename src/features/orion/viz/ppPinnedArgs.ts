// Launcher arguments for a viz card pinned to a run's inputs. Shapes are those of
// @sjcrh/proteinpaint-client 2.216.0 (gdc/correlation.ts, gdc/oncomatrix.js, gdc/DE.ts,
// plots/DEinput.ts, plots/diffAnalysis); a client bump must re-verify them.

import type {
  CohortGroup,
  DeMethod,
  GqlFilter,
  JsonValue,
  PinnedViz,
  SampleGroup,
  VizSpec,
  VolcanoPins,
} from '../agui/types';

export const PP_DSLABEL = 'MMRF';
export const PP_GENOME = 'hg38';
export const PINNED_SCHEMA = 'orion.viz-pinned/v1';

/** DEinput's colors for its first and second group (getColors(5): d3 Dark2), so the volcano matches. */
export const DE_GROUP_COLORS = ['#1b9e77', '#d95f02'] as const;

/** MatrixWrapper's default, so the card's Genes menu matches the full tool. */
export const ONCOMATRIX_MAX_GENES = 50;

/** Equal pinned inputs normalize equally: sample ids sort as ProteinPaint's DE cache key does. */
export const normalizePinned = (pinned: PinnedViz): PinnedViz => {
  if (pinned.kind !== 'deDirect') return pinned;
  const [control, kase] = pinned.groups.map((g) => ({
    name: g.name,
    sampleIds: [...g.sampleIds].sort((a, b) => a - b),
  }));
  return { ...pinned, groups: [control, kase] };
};

// ------------------------------------------------------------------ launcher args

interface LauncherBase {
  host: string;
  dslabel: typeof PP_DSLABEL;
  genome: typeof PP_GENOME;
  noheader: true;
  nobox: true;
  filter0: GqlFilter | null;
}

export interface SurvivalPlot {
  chartType: 'survival';
  term: { id: string };
  term2: { id: string };
}

interface SampleListGroup {
  name: string;
  in: true;
  values: { sampleId: number }[];
}

export interface DifferentialAnalysisPlot {
  chartType: 'differentialAnalysis';
  termType: 'geneExpression';
  samplelst: { groups: SampleListGroup[] };
  tw: {
    q: { groups: SampleListGroup[] };
    term: {
      name: string;
      type: 'samplelst';
      values: Record<string, { key: string; label: string; color: string; list: { sampleId: number }[] }>;
    };
  };
  settings: { volcano: VolcanoPins & { method: DeMethod; showPValueTable: true } };
}

interface CohortTvs {
  type: 'tvs';
  tvs: {
    term: { id: string; name: string; type: 'cohort'; filter0: GqlFilter; isleaf: true };
    /** filter/tvs.cohort.js labels the pill from values[0] and throws without it. */
    values: [{ key: string; label: string }];
  };
}

export interface DeInputPlot {
  chartType: 'DEinput';
  groups: { name: string; filter: { type: 'tvslst'; in: true; join: ''; lst: [CohortTvs] } }[];
  autoSubmit: true;
}

export type LauncherArgs =
  | (LauncherBase & { launchGdcCorrelation: true; state: { plots: [SurvivalPlot] } })
  | (LauncherBase & {
      launchGdcMatrix: true;
      hide_dsHandles: true;
      genes: string[];
      settings: { matrix: { maxGenes: number } };
    })
  | (LauncherBase & {
      launchGdcDE: true;
      filter0: null;
      state: { plots: [DifferentialAnalysisPlot | DeInputPlot] };
    });

const base = (host: string, filter0: GqlFilter | null): LauncherBase => ({
  host,
  dslabel: PP_DSLABEL,
  genome: PP_GENOME,
  noheader: true,
  nobox: true,
  filter0,
});

const sampleListGroup = (g: SampleGroup): SampleListGroup => ({
  name: g.name,
  in: true,
  values: g.sampleIds.map((sampleId) => ({ sampleId })),
});

/** The plot config DEinput itself dispatches after "Run" (mass/groups.js renderPreAnalysisData). */
const differentialAnalysisPlot = (
  groups: [SampleGroup, SampleGroup],
  method: DeMethod,
  volcano: VolcanoPins = {},
): DifferentialAnalysisPlot => {
  const lists = groups.map(sampleListGroup);
  const values: DifferentialAnalysisPlot['tw']['term']['values'] = {};
  lists.forEach((g, i) => {
    values[g.name] = { key: g.name, label: g.name, color: DE_GROUP_COLORS[i], list: g.values };
  });
  return {
    chartType: 'differentialAnalysis',
    termType: 'geneExpression',
    samplelst: { groups: lists },
    tw: {
      q: { groups: lists },
      term: { name: lists.map((g) => g.name).join(' vs '), type: 'samplelst', values },
    },
    settings: { volcano: { ...volcano, method, showPValueTable: true } },
  };
};

const cohortGroup = (g: CohortGroup): DeInputPlot['groups'][number] => ({
  name: g.name,
  filter: {
    type: 'tvslst',
    in: true,
    join: '',
    lst: [
      {
        type: 'tvs',
        tvs: {
          term: { id: g.cohortId, name: g.name, type: 'cohort', filter0: g.filter0, isleaf: true },
          values: [{ key: g.cohortId, label: g.name }],
        },
      },
    ],
  },
});

/**
 * Arguments for `bindProteinPaint({ initArgs })`, minus `holder`. No `updateArgs` is ever
 * sent, so the viewer never follows the live cohort the way the existing wrappers do.
 */
export const buildLauncherArgs = (input: PinnedViz, host: string): LauncherArgs => {
  const pinned = normalizePinned(input);
  switch (pinned.kind) {
    case 'survival':
      return {
        ...base(host, pinned.filter0),
        launchGdcCorrelation: true,
        state: {
          plots: [{ chartType: 'survival', term: { id: pinned.term }, term2: { id: pinned.overlay } }],
        },
      };
    case 'oncomatrix':
      return {
        ...base(host, pinned.filter0),
        launchGdcMatrix: true,
        hide_dsHandles: true,
        genes: [...pinned.genes],
        settings: { matrix: { maxGenes: ONCOMATRIX_MAX_GENES } },
      };
    case 'deDirect':
      // The groups are complete sample lists, so no app-level cohort narrows them; the run
      // body's filter0 (part of ProteinPaint's DE cache key) is then null, as de_run sends it.
      return {
        ...base(host, null),
        launchGdcDE: true,
        filter0: null,
        state: { plots: [differentialAnalysisPlot(pinned.groups, pinned.method, pinned.volcano)] },
      };
    case 'deInput':
      return {
        ...base(host, null),
        launchGdcDE: true,
        filter0: null,
        state: { plots: [{ chartType: 'DEinput', groups: pinned.groups.map(cohortGroup), autoSubmit: true }] },
      };
  }
};

/** The inputs a run's viz card mounts, checked against the launcher the snapshot names. */
export const pinnedFromVizSpec = (spec: VizSpec): PinnedViz => {
  if (spec.launcher !== spec.pinned.kind) {
    throw new Error(`Viz ${spec.vizId}: launcher ${spec.launcher} does not match pinned ${spec.pinned.kind}`);
  }
  return spec.pinned;
};

// ------------------------------------------------------------------ parity hash

/**
 * The agent's Python prints the same digits as JavaScript only for integers and for decimals
 * with 1e-4 <= |x| < 1e15. Larger integers are refused too: JavaScript cannot hold them exactly.
 */
const canonicalNumber = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error(`Cannot hash a non-finite number: ${value}`);
  const magnitude = Math.abs(value);
  const exact = Number.isInteger(value)
    ? Number.isSafeInteger(value)
    : magnitude >= 1e-4 && magnitude < 1e15;
  if (!exact) throw new Error(`Cannot hash ${value}: outside the range both sides print alike`);
  return JSON.stringify(value);
};

/**
 * JSON with object keys sorted at every level, array order kept, no whitespace, non-ASCII
 * left unescaped and undefined fields dropped. Throws on a number outside the contract's range.
 */
export const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number') return canonicalNumber(value);
  return JSON.stringify(value);
};

/** The object both sides hash: the normalized pinned inputs under a schema tag. */
export const pinnedDocument = (pinned: PinnedViz): JsonValue =>
  // Interfaces carry no index signature, but every field is JSON data; canonicalJson drops
  // optional fields left undefined.
  ({ schema: PINNED_SCHEMA, ...normalizePinned(pinned) }) as unknown as JsonValue;

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** sha256 of the canonical pinned document, for the parity badge (C-21). */
export const pinnedHash = async (
  pinned: PinnedViz,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> => {
  const bytes = new TextEncoder().encode(canonicalJson(pinnedDocument(pinned)));
  return toHex(await subtle.digest('SHA-256', bytes));
};
