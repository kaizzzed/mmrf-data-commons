// NFR-05: every browser client write (save_cohorts, set_active_cohort) is logged with its thread,
// run and step ids. The two writes run only inside click handlers.

export type ClientWriteAction = 'save_cohorts' | 'set_active_cohort';

export type ClientWriteOutcome = 'created' | 'reused' | 'activated' | 'undone' | 'failed';

export interface ClientWriteEntry {
  at: string;
  action: ClientWriteAction;
  threadId: string;
  /** Null for the composer's scope chip, which acts before any run exists. */
  runId: string | null;
  stepId: string | null;
  outcome: ClientWriteOutcome;
  cohortId: string | null;
  /** The cohort ref, the click's origin, or the failure. */
  detail: string;
}

export interface WriteLog {
  record(entry: Omit<ClientWriteEntry, 'at'>): ClientWriteEntry;
  entries(): readonly ClientWriteEntry[];
}

const MAX_ENTRIES = 200;

export const createWriteLog = (
  sink: (message: string, entry: ClientWriteEntry) => void = (message, entry) => console.info(message, entry),
  now: () => Date = () => new Date(),
): WriteLog => {
  let entries: ClientWriteEntry[] = [];
  return {
    record(partial) {
      const entry: ClientWriteEntry = { at: now().toISOString(), ...partial };
      entries = [...entries, entry].slice(-MAX_ENTRIES);
      sink('[orion] client write', entry);
      return entry;
    },
    entries: () => entries,
  };
};

/** The page's log: the console, plus the last entries in memory. */
export const writeLog: WriteLog = createWriteLog();
