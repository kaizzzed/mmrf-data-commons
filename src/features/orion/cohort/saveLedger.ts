// The save ledger (design "Data model", contract "save_cohorts tool call"): written to localStorage,
// keyed by the confirmation nonce, before any cohort is created, and updated after each one. A
// resent or resumed Create (E19) reads it and creates only the cohorts still missing.

export const LEDGER_PREFIX = 'orion:save-ledger:v1:';
/** Ledgers older than this are pruned whenever one is written. */
export const LEDGER_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface LedgerCohort {
  ref: string;
  /** The proposed name the save started from. */
  name: string;
  defSha256: string;
  /** Set once the cohort exists in the store, created or reused. */
  cohortId: string | null;
  savedName: string | null;
  reused: boolean;
}

export interface SaveLedger {
  nonce: string;
  threadId: string;
  runId: string;
  stepId: string;
  planSignature: string;
  planVersion: number;
  createdAt: string;
  updatedAt: string;
  cohorts: LedgerCohort[];
  /** When the confirm carrying this save's read-back was last sent. */
  confirmSentAt: string | null;
}

export interface LedgerStore {
  read(nonce: string): SaveLedger | null;
  /** False when storage refused the write; the save goes on, guarded by defSha256 reuse. */
  write(ledger: SaveLedger): boolean;
}

/** How far a save got: "1 of 2 saved". */
export interface SaveProgress {
  saved: number;
  total: number;
}

export const ledgerProgress = (ledger: SaveLedger | null): SaveProgress | null =>
  ledger
    ? { saved: ledger.cohorts.filter((c) => c.cohortId !== null).length, total: ledger.cohorts.length }
    : null;

const isLedger = (value: unknown): value is SaveLedger => {
  if (typeof value !== 'object' || value === null) return false;
  const ledger = value as Partial<SaveLedger>;
  return (
    typeof ledger.nonce === 'string' &&
    typeof ledger.planSignature === 'string' &&
    Array.isArray(ledger.cohorts) &&
    ledger.cohorts.every(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        typeof c.ref === 'string' &&
        typeof c.defSha256 === 'string' &&
        (c.cohortId === null || typeof c.cohortId === 'string'),
    )
  );
};

export const localLedgerStore = (
  storage: () => Storage = () => window.localStorage,
  now: () => number = () => Date.now(),
): LedgerStore => {
  const prune = (store: Storage): void => {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(LEDGER_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      try {
        const ledger: unknown = JSON.parse(store.getItem(key) ?? 'null');
        const updated = isLedger(ledger) ? Date.parse(ledger.updatedAt) : NaN;
        if (!(now() - updated < LEDGER_TTL_MS)) store.removeItem(key);
      } catch {
        store.removeItem(key);
      }
    }
  };
  return {
    read(nonce) {
      try {
        const parsed: unknown = JSON.parse(storage().getItem(LEDGER_PREFIX + nonce) ?? 'null');
        return isLedger(parsed) && parsed.nonce === nonce ? parsed : null;
      } catch {
        return null;
      }
    },
    write(ledger) {
      try {
        const store = storage();
        prune(store);
        store.setItem(LEDGER_PREFIX + ledger.nonce, JSON.stringify(ledger));
        return true;
      } catch {
        return false;
      }
    },
  };
};

/** For tests and pages without localStorage. */
export const memoryLedgerStore = (): LedgerStore & { all(): SaveLedger[] } => {
  const ledgers = new Map<string, SaveLedger>();
  return {
    read: (nonce) => {
      const ledger = ledgers.get(nonce);
      return ledger ? (JSON.parse(JSON.stringify(ledger)) as SaveLedger) : null;
    },
    write: (ledger) => {
      ledgers.set(ledger.nonce, JSON.parse(JSON.stringify(ledger)) as SaveLedger);
      return true;
    },
    all: () => [...ledgers.values()],
  };
};
