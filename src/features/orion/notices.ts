import type { InvocationKind, NoticeCode, ThreadNotice } from './agui/reducer';

// A rejected turn never became a run, so each line says what did not happen and what to do.
const NOTICES: Record<InvocationKind, Record<NoticeCode, string>> = {
  ask: {
    RUN_BUSY: 'A run is still active in this thread. Wait for it to finish, then ask again.',
    INVALID_INPUT: 'ORION could not read this request, so no run started. Try asking again.',
    RUN_NOT_FOUND: 'ORION did not start a run for this question. Try asking again.',
    NOT_IMPLEMENTED: 'ORION cannot take this request yet, so no run started.',
    STALE_ACTION: 'The paused run changed before this question reached ORION, so no run started. Try again.',
    SESSION_BUSY: 'ORION stayed busy with this thread, so the question was not sent. Try again in a moment.',
    UPSTREAM_ERROR: 'ORION could not start a run for this question. Try asking again.',
    UPSTREAM_TIMEOUT: 'ORION did not answer in time, so no run started. Try asking again.',
    UPSTREAM_UNAVAILABLE: 'ORION is unavailable right now, so no run started. Try again later.',
    UNAUTHENTICATED: 'Your session has ended, so no run started. Sign in again, then ask again.',
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
    SESSION_BUSY:
      'Stop did not go through: ORION stayed busy with this thread. The run shows the last status it reported.',
    UPSTREAM_ERROR:
      'Stop did not go through: ORION could not be reached. The run shows the last status it reported.',
    UPSTREAM_TIMEOUT:
      'Stop did not go through: ORION did not answer in time. The run shows the last status it reported.',
    UPSTREAM_UNAVAILABLE:
      'Stop did not go through: ORION is unavailable right now. The run shows the last status it reported.',
    UNAUTHENTICATED:
      'Stop did not go through: your session has ended. Sign in again; the run shows the last status it reported.',
  },
  other: {
    RUN_BUSY: 'A run is still active in this thread. Wait for it to finish, then try again.',
    INVALID_INPUT: 'ORION could not read this request, so nothing changed.',
    RUN_NOT_FOUND: 'ORION has no record of this run, so nothing changed.',
    NOT_IMPLEMENTED: 'ORION cannot do this yet, so nothing changed.',
    STALE_ACTION: 'The run had already moved on, so nothing changed. The card shows its latest state.',
    SESSION_BUSY: 'ORION stayed busy with this thread, so nothing changed. Try again in a moment.',
    UPSTREAM_ERROR: 'ORION could not be reached, so nothing changed. Try again.',
    UPSTREAM_TIMEOUT: 'ORION did not answer in time, so nothing changed. Try again.',
    UPSTREAM_UNAVAILABLE: 'ORION is unavailable right now, so nothing changed. Try again later.',
    UNAUTHENTICATED: 'Your session has ended, so nothing changed. Sign in again, then try again.',
  },
};

// The browser saves cohorts before it sends confirm, so a turned-away confirm leaves them saved.
const CONFIRM_NOTICE =
  'ORION did not take this confirmation, so the run did not continue. Any cohort the click already saved stays in your cohort list.';

// A Stop that reached ORION before its run did: the run was taken back, not left as it was.
const STOPPED_BEFORE_START =
  'ORION had not started this run, so there was nothing to stop. Ask again when you are ready.';

/** The thread's plain-language line for a rejected turn, shown and announced. */
export const noticeText = ({ turn, code, question, action }: ThreadNotice): string => {
  if (turn === 'cancel' && question !== null) return STOPPED_BEFORE_START;
  if (turn === 'other' && action === 'confirm' && code !== 'RUN_BUSY') return CONFIRM_NOTICE;
  return NOTICES[turn][code];
};
