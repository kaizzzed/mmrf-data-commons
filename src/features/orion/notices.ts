import type { InvocationKind, ThreadNotice } from './agui/reducer';
import type { RejectionCode } from './agui/types';

// A rejected turn never became a run, so each line says what did not happen and what to do.
const NOTICES: Record<InvocationKind, Record<RejectionCode, string>> = {
  ask: {
    RUN_BUSY: 'A run is still active in this thread. Wait for it to finish, then ask again.',
    INVALID_INPUT: 'ORION could not read this request, so no run started. Try asking again.',
    RUN_NOT_FOUND: 'ORION did not start a run for this question. Try asking again.',
    NOT_IMPLEMENTED: 'ORION cannot take this request yet, so no run started.',
    STALE_ACTION: 'The paused run changed before this question reached ORION, so no run started. Try again.',
  },
  cancel: {
    RUN_BUSY:
      'Stop did not go through: ORION is busy with this thread. The run shows the last status it reported.',
    INVALID_INPUT:
      'Stop did not go through: ORION could not read the request. The run shows the last status it reported.',
    RUN_NOT_FOUND:
      'Stop did not go through: ORION has no record of this run. The run shows the last status it reported.',
    NOT_IMPLEMENTED: 'ORION cannot stop this run yet. The run shows the last status it reported.',
    STALE_ACTION:
      'Stop did not go through: the run had already moved on. The run shows the last status it reported.',
  },
  other: {
    RUN_BUSY: 'A run is still active in this thread. Wait for it to finish, then try again.',
    INVALID_INPUT: 'ORION could not read this request, so nothing changed.',
    RUN_NOT_FOUND: 'ORION has no record of this run, so nothing changed.',
    NOT_IMPLEMENTED: 'ORION cannot do this yet, so nothing changed.',
    STALE_ACTION: 'The run had already moved on, so nothing changed. The card shows its latest state.',
  },
};

// A Stop that reached ORION before its run did: the run was taken back, not left as it was.
const STOPPED_BEFORE_START =
  'ORION had not started this run, so there was nothing to stop. Ask again when you are ready.';

/** The thread's plain-language line for a rejected turn, shown and announced. */
export const noticeText = ({ turn, code, question }: ThreadNotice): string =>
  turn === 'cancel' && question !== null ? STOPPED_BEFORE_START : NOTICES[turn][code];
