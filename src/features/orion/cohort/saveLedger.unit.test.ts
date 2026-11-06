import { LEDGER_PREFIX, LEDGER_TTL_MS, ledgerProgress, localLedgerStore, type SaveLedger } from './saveLedger';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');

const ledger = (nonce: string, updatedAt = new Date(NOW).toISOString()): SaveLedger => ({
  nonce,
  threadId: 't'.repeat(32),
  runId: 'r'.repeat(32),
  stepId: 's8',
  planSignature: 'p'.repeat(64),
  planVersion: 1,
  createdAt: updatedAt,
  updatedAt,
  confirmSentAt: null,
  cohorts: [
    { ref: 'kras_wt', name: 'KRAS not detected (ORION)', defSha256: 'a'.repeat(64), cohortId: 'c-1', savedName: 'x', reused: false },
    { ref: 'kras_mut', name: 'KRAS mutated (ORION)', defSha256: 'b'.repeat(64), cohortId: null, savedName: null, reused: false },
  ],
});

beforeEach(() => window.localStorage.clear());

describe('the save ledger', () => {
  it('round-trips through localStorage, keyed by the nonce', () => {
    const store = localLedgerStore(undefined, () => NOW);
    expect(store.write(ledger('n1'))).toBe(true);
    expect(window.localStorage.getItem(`${LEDGER_PREFIX}n1`)).not.toBeNull();
    expect(store.read('n1')).toEqual(ledger('n1'));
    expect(store.read('n2')).toBeNull();
    expect(ledgerProgress(store.read('n1'))).toEqual({ saved: 1, total: 2 });
    expect(ledgerProgress(null)).toBeNull();
  });

  it('prunes ledgers older than its time to live when it writes', () => {
    const store = localLedgerStore(undefined, () => NOW);
    store.write(ledger('old', new Date(NOW - LEDGER_TTL_MS - 1).toISOString()));
    window.localStorage.setItem(`${LEDGER_PREFIX}torn`, '{');
    window.localStorage.setItem('other-key', 'kept');
    store.write(ledger('new'));
    expect(store.read('old')).toBeNull();
    expect(window.localStorage.getItem(`${LEDGER_PREFIX}torn`)).toBeNull();
    expect(window.localStorage.getItem('other-key')).toBe('kept');
    expect(store.read('new')).not.toBeNull();
  });

  it('ignores a stored value that is not a ledger for that nonce', () => {
    window.localStorage.setItem(`${LEDGER_PREFIX}n1`, JSON.stringify({ ...ledger('n2') }));
    expect(localLedgerStore().read('n1')).toBeNull();
    window.localStorage.setItem(`${LEDGER_PREFIX}n3`, JSON.stringify({ nonce: 'n3' }));
    expect(localLedgerStore().read('n3')).toBeNull();
  });

  it('never throws when storage is blocked', () => {
    const blocked = localLedgerStore(() => {
      throw new Error('blocked');
    });
    expect(blocked.write(ledger('n1'))).toBe(false);
    expect(blocked.read('n1')).toBeNull();
  });
});
